// ==UserScript==
// @name         Instagram Video Controls with Persistent UI, Volume, Speed, Boost & Ad Blocker
// @description  Draggable UI for volume, mute, seek, play/pause, autoplay, background play, speed, boost and Reels ad blocker (now handles image ads)
// @namespace    http://tampermonkey.net/
// @version      0.2.5
// @author       mod
// @match        *://*.instagram.com/reels/*
// @match        *://*.instagram.com/reel/*
// @match        *://*.instagram.com/*
// @match        *://*.facebook.com/reel/*
// @match        *://*.facebook.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/537876/Instagram%20Video%20Controls%20with%20Persistent%20UI%2C%20Volume%2C%20Speed%2C%20Boost%20%20Ad%20Blocker.user.js
// @updateURL https://update.greasyfork.org/scripts/537876/Instagram%20Video%20Controls%20with%20Persistent%20UI%2C%20Volume%2C%20Speed%2C%20Boost%20%20Ad%20Blocker.meta.js
// ==/UserScript==

/* ==================== CHANGELOG ====================
   0.2.5 – Now detects and removes static image ads (photo reels).
           Unified media handler, image recognition, card‑based skipping.
   0.2.4 – Fixed ad blocker not detecting ads on first load by removing the
           500ms startup delay – observers now start immediately.
   0.2.3 – Changed @match to reels-specific pages.
         - "Show AD skip msg" now defaults off, label updated.
         - New dedicated row for ad skip message (appears only when enabled).
         - Message format matches console log, truncated to fit panel.
   0.2.2 – Fixed “Show skip msg” not appearing correctly on first load.
         - Ad‑blocked message now stays visible for 2s, then fades over 2s.
   0.2.1 – Fixed ad blocker not working by adding @run-at document-idle
           and a 500ms delay before starting the ad observer.
   0.2.0 – Integrated Reels ad blocker with UI toggles.
         - New checkboxes: "Ad block" and "Show skip msg".
         - Red fading notification when an ad is removed.
   0.1.8 – Added volume boost (Audio API gain) with preset buttons and
           custom input. Boost is applied only to the active video.
   0.1.7 – Fixed text color contrast: all text now forced to white (#fff)
           with a soft text‑shadow for better readability over video.
   0.1.6 – Added playback speed control (presets + custom input).
         - Speed stored in settings and applied to all videos.
   0.1.5 – Fixed seek slider not responding after scrolling many videos.
   0.1.4 – Added "Bg play" checkbox (default on) to keep videos playing
           when the tab is not focused.
         - Integrated muted guard to prevent Instagram muting.
   0.1.3 – Added autoplay checkbox and reset‑to‑start behaviour.
   0.1.2 – Added play/pause button, progress bar, time display.
   0.1.0 – Added seek bar to floating UI.
   0.0.8 – Original floating volume/mute control.
===================================================== */

(function () {
    const POS_KEY = 'igvc-ui-position';
    const SETTINGS_KEY = 'igvc-settings';

    // ---------- Global logging control ----------
    const VERBOSE_LOG = false;   // Set to true to see detailed identity logs for every reel
    const LOG_TAG = '[IGVC]';

    const log  = (...a) => { if (VERBOSE_LOG) console.log(LOG_TAG, ...a); };
    const warn = (...a) => { if (VERBOSE_LOG) console.warn(LOG_TAG, ...a); };
    const error = (...a) => console.error(LOG_TAG, ...a);

    // ---------- Settings ----------
    const settings = loadSettings();
    let activeVideo = null;
    let isSeeking = false;
    let progressSlider = null;
    let timeLabel = null;
    let playPauseBtn = null;
    let bgPlayCheckbox = null;
    let speedButtons = [];
    let customSpeedInput = null;
    let boostButtons = [];
    let customBoostInput = null;

    let audioCtx = null;

    // ---------- Ad Blocker variables ----------
    let adBlockEnabledCheckbox = null;
    let skipMsgCheckbox = null;
    let adSkipMsgSpan = null;
    let adMsgRow = null;

    // Observers for both video and image ads
    let mediaObserver = null;          // IntersectionObserver
    let mediaMutationObserver = null;  // MutationObserver

    // Track processed reel cards to avoid duplicate work
    const processedCards = new WeakSet();

    // Attributes to mark processed media sources
    const ATTR_VIDEO = 'data-ad-blocker-src';
    const ATTR_IMAGE = 'data-ad-blocker-img';

    const debounce = (func, wait) => {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    };

    // ---- muted guard (prevents Instagram from re-muting) ----
    const nativeMutedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');

    function installMutedGuard(video) {
        if (!video || video.__igvcMutedGuardInstalled || !nativeMutedDescriptor) return;
        video.__igvcMutedGuardInstalled = true;
        video.__igvcOriginalSetAttribute = video.setAttribute;

        Object.defineProperty(video, 'muted', {
            configurable: true,
            get() { return nativeMutedDescriptor.get.call(this); },
            set(value) {
                const shouldMute = Boolean(value);
                if (!shouldMute || this.__igvcAllowMutedChange) {
                    nativeMutedDescriptor.set.call(this, shouldMute);
                }
                return nativeMutedDescriptor.get.call(this);
            }
        });

        video.setAttribute = function(name, value) {
            if (String(name).toLowerCase() === 'muted' && !this.__igvcAllowMutedChange) return;
            return this.__igvcOriginalSetAttribute.call(this, name, value);
        };
    }

    function setVideoMuted(video, muted) {
        if (!video) return;
        installMutedGuard(video);
        video.__igvcAllowMutedChange = true;
        try {
            video.muted = Boolean(muted);
            video.removeAttribute('muted');
        } finally {
            video.__igvcAllowMutedChange = false;
        }
    }

    function enableBackgroundPlayOnVideo(video) {
        if (!video || video._igvcBgPlayActive) return;
        video._igvcBgPlayActive = true;
        if (!video._igvcOriginalPause) {
            video._igvcOriginalPause = video.pause;
            video.pause = function () {
                if (video._igvcForcePause) {
                    delete video._igvcForcePause;
                    return video._igvcOriginalPause.call(video);
                }
                if (settings.backgroundPlay && document.hidden && !video.ended) {
                    return Promise.resolve();
                }
                return video._igvcOriginalPause.call(video);
            };
        }
    }

    function disableBackgroundPlayOnVideo(video) {
        if (!video || !video._igvcBgPlayActive) return;
        if (video._igvcOriginalPause) {
            video.pause = video._igvcOriginalPause;
            delete video._igvcOriginalPause;
        }
        video._igvcBgPlayActive = false;
    }

    function applyBackgroundPlayToAll() {
        document.querySelectorAll('video').forEach(video => {
            if (settings.backgroundPlay) {
                enableBackgroundPlayOnVideo(video);
            } else {
                disableBackgroundPlayOnVideo(video);
                if (document.hidden && !video.paused && video === activeVideo) {
                    video.pause();
                }
            }
        });
    }

    // ---- settings ----
    function loadSettings() {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                return {
                    volume:   typeof parsed.volume   === 'number'  ? parsed.volume   : 0.5,
                    muted:    typeof parsed.muted    === 'boolean' ? parsed.muted    : false,
                    autoplay: typeof parsed.autoplay === 'boolean' ? parsed.autoplay : true,
                    backgroundPlay: typeof parsed.backgroundPlay === 'boolean' ? parsed.backgroundPlay : true,
                    speed:    typeof parsed.speed    === 'number' && parsed.speed > 0 ? parsed.speed : 1,
                    boost:    typeof parsed.boost    === 'number' && parsed.boost > 0 ? parsed.boost : 1,
                    adBlockEnabled: typeof parsed.adBlockEnabled === 'boolean' ? parsed.adBlockEnabled : true,
                    showSkipLogs:   typeof parsed.showSkipLogs   === 'boolean' ? parsed.showSkipLogs   : false
                };
            } catch {
                return { volume: 0.5, muted: false, autoplay: true, backgroundPlay: true, speed: 1, boost: 1, adBlockEnabled: true, showSkipLogs: false };
            }
        }
        return { volume: 0.5, muted: false, autoplay: true, backgroundPlay: true, speed: 1, boost: 1, adBlockEnabled: true, showSkipLogs: false };
    }

    function saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    // ---- UI helpers ----
    function formatTime(seconds) {
        if (!isFinite(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function updatePlayButton() {
        if (!playPauseBtn) return;
        if (!activeVideo || activeVideo.paused) {
            playPauseBtn.textContent = '▶';
            playPauseBtn.title = 'Play';
        } else {
            playPauseBtn.textContent = '⏸';
            playPauseBtn.title = 'Pause';
        }
    }

    function updateTimeDisplay() {
        if (!activeVideo || !progressSlider) return;
        const dur = isFinite(activeVideo.duration) ? activeVideo.duration : 0;
        progressSlider.max = dur;
        progressSlider.value = activeVideo.currentTime;
        if (timeLabel) {
            timeLabel.textContent = `${formatTime(activeVideo.currentTime)} / ${formatTime(dur)}`;
        }
    }

    function onTimeUpdate() {
        if (!progressSlider || isSeeking || !activeVideo) return;
        progressSlider.max = isFinite(activeVideo.duration) ? activeVideo.duration : 0;
        progressSlider.value = activeVideo.currentTime;
        if (timeLabel) {
            timeLabel.textContent = `${formatTime(activeVideo.currentTime)} / ${formatTime(activeVideo.duration)}`;
        }
    }

    function setActiveVideo(video) {
        if (activeVideo === video) return;
        if (activeVideo) {
            activeVideo.removeEventListener('timeupdate', onTimeUpdate);
            if (activeVideo._metadataListener) {
                activeVideo.removeEventListener('loadedmetadata', activeVideo._metadataListener);
                activeVideo.removeEventListener('durationchange', activeVideo._metadataListener);
            }
            if (activeVideo._igvcBoostGain) {
                try { activeVideo._igvcBoostGain.disconnect(); } catch(e) {}
                delete activeVideo._igvcBoostGain;
            }
            if (activeVideo._igvcBoostSource) {
                try { activeVideo._igvcBoostSource.disconnect(); } catch(e) {}
                delete activeVideo._igvcBoostSource;
            }
        }
        activeVideo = video;
        if (progressSlider) {
            progressSlider.value = 0;
            progressSlider.max = 0;
        }
        if (timeLabel) timeLabel.textContent = '0:00 / 0:00';

        const updateOnce = () => {
            if (activeVideo !== video) return;
            updateTimeDisplay();
            video.removeEventListener('loadedmetadata', updateOnce);
            video.removeEventListener('durationchange', updateOnce);
            delete video._metadataListener;
        };
        video.addEventListener('loadedmetadata', updateOnce);
        video.addEventListener('durationchange', updateOnce);
        video._metadataListener = updateOnce;

        video.addEventListener('timeupdate', onTimeUpdate);
        updatePlayButton();
        updateSpeedUI();
        updateBoostUI();

        setupBoostForVideo(video);
    }

    function resetToStart(video) {
        if (video.readyState >= 1) {
            video.currentTime = 0;
        } else {
            video.addEventListener('loadedmetadata', () => { video.currentTime = 0; }, { once: true });
        }
    }

    // ---- Speed controls ----
    const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3, 4];

    function applySpeed(speed) {
        const parsed = parseFloat(speed);
        if (!isFinite(parsed) || parsed <= 0) return;
        settings.speed = parsed;
        saveSettings();
        if (activeVideo) {
            try {
                activeVideo.playbackRate = parsed;
            } catch (e) {}
        }
        updateSpeedUI();
    }

    function updateSpeedUI() {
        const currentSpeed = activeVideo ? activeVideo.playbackRate : settings.speed;
        speedButtons.forEach(btn => {
            const btnSpeed = parseFloat(btn.dataset.speed);
            if (Math.abs(btnSpeed - currentSpeed) < 0.001) {
                btn.style.background = 'rgba(255,255,255,0.3)';
                btn.style.borderColor = '#FF00FF';
            } else {
                btn.style.background = 'rgba(255,255,255,0.15)';
                btn.style.borderColor = 'rgba(255,255,255,0.3)';
            }
        });
        if (customSpeedInput) {
            customSpeedInput.value = currentSpeed;
        }
    }

    function createSpeedRow() {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.marginBottom = '4px';
        row.style.gap = '4px';

        const label = document.createElement('label');
        label.textContent = 'Speed:';
        label.style.whiteSpace = 'nowrap';
        label.style.fontSize = '11px';
        label.style.color = '#ffffff';
        label.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        row.appendChild(label);

        SPEED_PRESETS.forEach(sp => {
            const btn = document.createElement('button');
            btn.textContent = sp + 'x';
            btn.dataset.speed = sp;
            btn.title = 'Set speed to ' + sp + 'x';
            btn.style.cursor = 'pointer';
            btn.style.background = 'rgba(255,255,255,0.15)';
            btn.style.border = '1px solid rgba(255,255,255,0.3)';
            btn.style.color = '#ffffff';
            btn.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
            btn.style.borderRadius = '4px';
            btn.style.padding = '2px 6px';
            btn.style.fontSize = '11px';
            btn.style.lineHeight = '1.4';

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                applySpeed(sp);
            });
            row.appendChild(btn);
            speedButtons.push(btn);
        });

        customSpeedInput = document.createElement('input');
        customSpeedInput.type = 'text';
        customSpeedInput.placeholder = 'Custom';
        customSpeedInput.style.width = '50px';
        customSpeedInput.style.background = 'rgba(255,255,255,0.15)';
        customSpeedInput.style.border = '1px solid rgba(255,255,255,0.3)';
        customSpeedInput.style.color = '#ffffff';
        customSpeedInput.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        customSpeedInput.style.borderRadius = '4px';
        customSpeedInput.style.padding = '2px 4px';
        customSpeedInput.style.fontSize = '11px';
        customSpeedInput.value = settings.speed;

        const applyCustomSpeed = () => {
            const val = parseFloat(customSpeedInput.value);
            if (isFinite(val) && val > 0) {
                applySpeed(val);
            } else {
                customSpeedInput.value = settings.speed;
            }
        };

        customSpeedInput.addEventListener('blur', applyCustomSpeed);
        customSpeedInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                customSpeedInput.blur();
            }
        });

        row.appendChild(customSpeedInput);
        return row;
    }

    // ---- Boost controls (Audio API) ----
    const BOOST_PRESETS = [1, 1.5, 2, 3, 4];

    function applyBoost(boost) {
        const parsed = parseFloat(boost);
        if (!isFinite(parsed) || parsed <= 0) return;
        settings.boost = parsed;
        saveSettings();
        updateBoostUI();
        if (activeVideo && activeVideo._igvcBoostGain) {
            try {
                activeVideo._igvcBoostGain.gain.value = parsed;
            } catch (e) {}
        }
    }

    function updateBoostUI() {
        const currentBoost = settings.boost;
        boostButtons.forEach(btn => {
            const btnBoost = parseFloat(btn.dataset.boost);
            if (Math.abs(btnBoost - currentBoost) < 0.001) {
                btn.style.background = 'rgba(255,255,255,0.3)';
                btn.style.borderColor = '#FF00FF';
            } else {
                btn.style.background = 'rgba(255,255,255,0.15)';
                btn.style.borderColor = 'rgba(255,255,255,0.3)';
            }
        });
        if (customBoostInput) {
            customBoostInput.value = currentBoost;
        }
    }

    function setupBoostForVideo(video) {
        if (!video) return;
        if (video._igvcBoostSource) {
            try { video._igvcBoostSource.disconnect(); } catch(e) {}
        }
        if (video._igvcBoostGain) {
            try { video._igvcBoostGain.disconnect(); } catch(e) {}
        }
        if (!audioCtx) {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn('IGVC: Could not create AudioContext for boost', e);
                return;
            }
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        try {
            const source = audioCtx.createMediaElementSource(video);
            const gainNode = audioCtx.createGain();
            gainNode.gain.value = settings.boost;
            source.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            video._igvcBoostSource = source;
            video._igvcBoostGain = gainNode;
        } catch (e) {
            console.warn('IGVC: Could not set up boost for video', e);
        }
    }

    function createBoostRow() {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.marginBottom = '4px';
        row.style.gap = '4px';

        const label = document.createElement('label');
        label.textContent = 'Boost vol:';
        label.style.whiteSpace = 'nowrap';
        label.style.fontSize = '11px';
        label.style.color = '#ffffff';
        label.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        row.appendChild(label);

        BOOST_PRESETS.forEach(b => {
            const btn = document.createElement('button');
            btn.textContent = b + 'x';
            btn.dataset.boost = b;
            btn.title = 'Set boost to ' + b + 'x';
            btn.style.cursor = 'pointer';
            btn.style.background = 'rgba(255,255,255,0.15)';
            btn.style.border = '1px solid rgba(255,255,255,0.3)';
            btn.style.color = '#ffffff';
            btn.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
            btn.style.borderRadius = '4px';
            btn.style.padding = '2px 6px';
            btn.style.fontSize = '11px';
            btn.style.lineHeight = '1.4';

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                applyBoost(b);
            });
            row.appendChild(btn);
            boostButtons.push(btn);
        });

        customBoostInput = document.createElement('input');
        customBoostInput.type = 'text';
        customBoostInput.placeholder = 'Custom';
        customBoostInput.style.width = '50px';
        customBoostInput.style.background = 'rgba(255,255,255,0.15)';
        customBoostInput.style.border = '1px solid rgba(255,255,255,0.3)';
        customBoostInput.style.color = '#ffffff';
        customBoostInput.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        customBoostInput.style.borderRadius = '4px';
        customBoostInput.style.padding = '2px 4px';
        customBoostInput.style.fontSize = '11px';
        customBoostInput.value = settings.boost;

        const applyCustomBoost = () => {
            const val = parseFloat(customBoostInput.value);
            if (isFinite(val) && val > 0) {
                applyBoost(val);
            } else {
                customBoostInput.value = settings.boost;
            }
        };

        customBoostInput.addEventListener('blur', applyCustomBoost);
        customBoostInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                customBoostInput.blur();
            }
        });

        row.appendChild(customBoostInput);
        return row;
    }

    // ---- Ad Blocker module (integrated) ----

    function truncateText(text, maxLen = 45) {
        if (text.length <= maxLen) return text;
        return text.slice(0, maxLen - 1) + '…';
    }

    function showAdSkipMessage(details) {
        if (!adSkipMsgSpan || !adMsgRow) return;
        if (!settings.showSkipLogs) return;

        let fullMsg = `${LOG_TAG} 🚫 AD: ${details}`;
        const truncated = truncateText(fullMsg, 45);
        adSkipMsgSpan.textContent = truncated;

        clearTimeout(adMsgRow._visibleTimer);
        clearTimeout(adMsgRow._fadeTimer);

        adMsgRow.style.display = 'flex';
        adSkipMsgSpan.style.transition = 'opacity 0.5s';
        adSkipMsgSpan.style.opacity = '1';

        adMsgRow._visibleTimer = setTimeout(() => {
            adSkipMsgSpan.style.transition = 'opacity 2s';
            adSkipMsgSpan.style.opacity = '0';
        }, 10000);

        adMsgRow._fadeTimer = setTimeout(() => {
            adMsgRow.style.display = 'none';
            adSkipMsgSpan.textContent = '';
        }, 8000);
    }

    function toggleAdMessageRow() {
        if (!adMsgRow) return;
        if (!settings.showSkipLogs) {
            clearTimeout(adMsgRow._visibleTimer);
            clearTimeout(adMsgRow._fadeTimer);
            adMsgRow.style.display = 'none';
            adSkipMsgSpan.style.opacity = '0';
            adSkipMsgSpan.textContent = '';
        }
    }

    function getReelUsername(reelCard) {
        try {
            const profileLink = reelCard.querySelector('a[aria-label$=" reels"]');
            if (profileLink) {
                const aria = profileLink.getAttribute('aria-label') || '';
                const username = aria.replace(/\s*reels$/i, '').trim();
                if (username) return `@${username}`;
            }
            const nameSpan = reelCard.querySelector('span.x1lliihq.x1plvlek span');
            if (nameSpan) {
                const txt = nameSpan.textContent.trim();
                if (txt && txt.length < 30) return `@${txt}`;
            }
        } catch (e) {
            error("Error extracting username:", e);
        }
        return null;
    }

    function getReelDescription(reelCard) {
        try {
            const descDiv = reelCard.querySelector('[role="presentation"] .x1xmf6yo > div[dir="auto"]');
            if (descDiv) {
                const text = descDiv.textContent?.trim();
                if (text && text.length > 0) {
                    return text.length > 60 ? text.slice(0, 60) + '…' : text;
                }
            }
            const anyDirAuto = reelCard.querySelector('div[dir="auto"]');
            if (anyDirAuto) {
                const text = anyDirAuto.textContent?.trim();
                if (text && text.length > 0) {
                    return text.length > 60 ? text.slice(0, 60) + '…' : text;
                }
            }
        } catch (e) {
            error("Error extracting description:", e);
        }
        return null;
    }

    function getReelIdentity(element) {
        try {
            const reelCard = element.closest('.x1qjc9v5') ||
                             element.closest('article') ||
                             element.closest('[role="article"]');
            if (!reelCard) return { label: '(no card)', description: null };
            const username = getReelUsername(reelCard);
            const description = getReelDescription(reelCard);
            return { label: username || '(no username)', description };
        } catch (e) {
            error("Error identifying reel:", e);
            return { label: '(error)', description: null };
        }
    }

    function checkForAd(element) {
        try {
            let el = element.parentElement;
            while (el && el !== document.body) {
                if (el.querySelector('a[href*="ig_redirect"]')) {
                    const videoCount = el.querySelectorAll('video').length;
                    if (videoCount <= 3) return { isAd: true, container: el };
                    break;
                }
                const adSpans = el.querySelectorAll('span[dir="auto"]');
                for (const span of adSpans) {
                    if (span.children.length === 0 && span.textContent.trim() === 'Ad') {
                        const videoCount = el.querySelectorAll('video').length;
                        if (videoCount <= 3) return { isAd: true, container: el };
                        break;
                    }
                }
                el = el.parentElement;
            }
        } catch (e) {
            error("Error checking for ad:", e);
        }
        return { isAd: false, container: null };
    }

    // Skip to next reel card (not just video)
    function skipToNextReel(currentElement) {
        try {
            const currentCard = currentElement.closest('.x1qjc9v5') ||
                                currentElement.closest('article');
            if (!currentCard) { warn("No current reel card found"); return; }

            // Find next reel card
            let nextCard = currentCard.nextElementSibling;
            if (!nextCard || !nextCard.matches('.x1qjc9v5')) {
                nextCard = currentCard.parentElement?.querySelector('.x1qjc9v5:not([data-processed])');
            }
            if (!nextCard || !nextCard.matches('.x1qjc9v5')) {
                warn("No next reel card found");
                return;
            }

            const scrollContainer = nextCard.closest('[style*="scroll-snap-type"]') ||
                                    nextCard.closest('.x78zum5.xdt5ytf') ||
                                    document.scrollingElement;
            const oldSnap = scrollContainer?.style?.scrollSnapType;
            if (scrollContainer) scrollContainer.style.scrollSnapType = 'none';

            requestAnimationFrame(() => {
                nextCard.scrollIntoView({ behavior: 'auto', block: 'center' });
                setTimeout(() => {
                    if (scrollContainer && oldSnap !== undefined) {
                        scrollContainer.style.scrollSnapType = oldSnap;
                    }
                }, 150);
            });
        } catch (e) {
            error("Error during skip:", e);
        }
    }

    // Determine if an image is the main reel media (not a tiny icon or profile picture)
    function isReelImage(img) {
        if (!img || !img.tagName || img.tagName !== 'IMG') return false;
        // Ignore profile pictures
        if (img.alt && /profile picture/i.test(img.alt)) return false;
        // Only look inside reel cards
        const reelCard = img.closest('.x1qjc9v5');
        if (!reelCard) return false;
        // Main reel images are large (natural size > 100px) or have specific classes
        if (img.naturalWidth > 100 && img.naturalHeight > 100) return true;
        if (img.classList.contains('x5yr21d') && img.classList.contains('xu96u03')) return true;
        return false;
    }

    function handleMedia(element, attr) {
    // Ignore ALL images — only process videos
    if (element.tagName !== 'VIDEO') return;

    if (!settings.adBlockEnabled) return;

    try {
        const currentSrc = element.src || element.currentSrc || '';
        const lastSrc = element.getAttribute(attr);
        if (lastSrc === currentSrc) return;
        element.setAttribute(attr, currentSrc);

        const reelCard = element.closest('.x1qjc9v5') ||
                         element.closest('article') ||
                         element.closest('[role="article"]');
        if (!reelCard || processedCards.has(reelCard)) return;

        const { isAd, container } = checkForAd(element);
        const { label, description } = getReelIdentity(element);
        const details = description ? `${label} | "${description}"` : label;


            if (isAd) {
                if (settings.showSkipLogs) {
                    console.log(`${LOG_TAG} 🚫 AD: ${details}`);
                }
                showAdSkipMessage(details);

                // Pause video if it's a video ad
                if (element.tagName === 'VIDEO') {
                    element.pause();
                    element.muted = true;
                    element.currentTime = 0;
                }

                // Remove the reel card
                processedCards.add(reelCard);
                reelCard.remove();

                // Auto‑scroll to the next reel
                skipToNextReel(element);
            } else {
                log(`✅ Normal reel: ${details}`);
                if (element.tagName === 'VIDEO' && element.style.display === 'none') {
                    element.style.display = '';
                }
                processedCards.add(reelCard);
            }
        } catch (e) {
            error("Critical error in ad handler:", e);
        }
    }

    function startAdBlockObservers() {
        if (mediaObserver) return;

        // IntersectionObserver for both video and qualifying images
        mediaObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                    const target = entry.target;
                    if (target.tagName === 'VIDEO') {
                        handleMedia(target, ATTR_VIDEO);
                    } else if (target.tagName === 'IMG') {
                        handleMedia(target, ATTR_IMAGE);
                    }
                }
            }
        }, { threshold: [0.5] });

        // MutationObserver to pick up new videos and images
        mediaMutationObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'VIDEO') {
                        mediaObserver.observe(node);
                    } else {
                        node.querySelectorAll('video').forEach(v => mediaObserver.observe(v));
                    }
                    if (node.tagName === 'IMG' && isReelImage(node)) {
                        mediaObserver.observe(node);
                    } else {
                        const imgs = node.querySelectorAll('img');
                        for (const img of imgs) {
                            if (isReelImage(img)) mediaObserver.observe(img);
                        }
                    }
                }
            }
        });
        mediaMutationObserver.observe(document.body, { childList: true, subtree: true });

        // Observe existing media
        document.querySelectorAll('video').forEach(v => mediaObserver.observe(v));
        document.querySelectorAll('img').forEach(img => {
            if (isReelImage(img)) mediaObserver.observe(img);
        });

        log('Ad blocker observers started (video + image).');
    }

    function stopAdBlockObservers() {
        if (mediaObserver) {
            mediaObserver.disconnect();
            mediaObserver = null;
        }
        if (mediaMutationObserver) {
            mediaMutationObserver.disconnect();
            mediaMutationObserver = null;
        }
        log('Ad blocker observers stopped.');
    }

    // ---- UI creation ----
    const createControlUI = () => {
        const container = document.createElement('div');
        container.id = 'igvc-floating-ui';
        container.style.position = 'fixed';
        container.style.top = '10px';
        container.style.right = '10px';
        container.style.zIndex = '9999';
        container.style.background = 'rgba(0,0,0,0.7)';
        container.style.color = '#ffffff';
        container.style.padding = '6px 10px';
        container.style.borderRadius = '8px';
        container.style.fontSize = '12px';
        container.style.fontFamily = 'sans-serif';
        container.style.cursor = 'move';
        container.style.userSelect = 'none';
        container.style.minWidth = '260px';
        container.style.setProperty('color', '#ffffff', 'important');
        container.style.setProperty('text-shadow', '0 0 2px rgba(0,0,0,0.8)', 'important');

        const savedPos = localStorage.getItem(POS_KEY);
        if (savedPos) {
            const { top, left } = JSON.parse(savedPos);
            container.style.top = top;
            container.style.left = left;
            container.style.right = 'auto';
        }

        // --- Row 1: Volume + Mute ---
        const row1 = document.createElement('div');
        row1.style.display = 'flex';
        row1.style.alignItems = 'center';
        row1.style.marginBottom = '4px';

        const volumeLabel = document.createElement('label');
        volumeLabel.textContent = 'Vol: ';
        volumeLabel.style.marginRight = '4px';
        volumeLabel.style.whiteSpace = 'nowrap';
        volumeLabel.style.color = '#ffffff';
        volumeLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '1';
        volumeSlider.step = '0.01';
        volumeSlider.value = settings.volume;
        volumeSlider.style.flex = '1';
        volumeSlider.style.verticalAlign = 'middle';

        const muteLabel = document.createElement('label');
        muteLabel.textContent = 'Mute';
        muteLabel.style.marginLeft = '8px';
        muteLabel.style.whiteSpace = 'nowrap';
        muteLabel.style.color = '#ffffff';
        muteLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';

        const muteCheckbox = document.createElement('input');
        muteCheckbox.type = 'checkbox';
        muteCheckbox.checked = settings.muted;
        muteCheckbox.style.marginLeft = '4px';

        volumeSlider.addEventListener('input', () => {
            settings.volume = parseFloat(volumeSlider.value);
            settings.muted = false;
            muteCheckbox.checked = false;
            saveSettings();
            applySettingsToAll();
        });

        muteCheckbox.addEventListener('change', () => {
            settings.muted = muteCheckbox.checked;
            saveSettings();
            applySettingsToAll();
        });

        row1.appendChild(volumeLabel);
        row1.appendChild(volumeSlider);
        row1.appendChild(muteLabel);
        row1.appendChild(muteCheckbox);

        // --- Row 2: Seek ---
        const row2 = document.createElement('div');
        row2.style.display = 'flex';
        row2.style.alignItems = 'center';
        row2.style.marginBottom = '4px';

        const progressLabel = document.createElement('label');
        progressLabel.textContent = 'Seek: ';
        progressLabel.style.marginRight = '4px';
        progressLabel.style.whiteSpace = 'nowrap';
        progressLabel.style.color = '#ffffff';
        progressLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';

        progressSlider = document.createElement('input');
        progressSlider.type = 'range';
        progressSlider.min = '0';
        progressSlider.max = '0';
        progressSlider.step = '0.1';
        progressSlider.value = '0';
        progressSlider.style.flex = '1';
        progressSlider.style.verticalAlign = 'middle';

        timeLabel = document.createElement('span');
        timeLabel.textContent = '0:00 / 0:00';
        timeLabel.style.marginLeft = '6px';
        timeLabel.style.whiteSpace = 'nowrap';
        timeLabel.style.fontSize = '11px';
        timeLabel.style.opacity = '0.9';
        timeLabel.style.color = '#ffffff';
        timeLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';

        progressSlider.addEventListener('mousedown', () => { isSeeking = true; });
        progressSlider.addEventListener('touchstart', () => { isSeeking = true; });
        progressSlider.addEventListener('input', () => {
            if (activeVideo) {
                activeVideo.currentTime = parseFloat(progressSlider.value);
                if (timeLabel) {
                    timeLabel.textContent = `${formatTime(activeVideo.currentTime)} / ${formatTime(activeVideo.duration)}`;
                }
            }
        });
        progressSlider.addEventListener('mouseup', () => { isSeeking = false; });
        progressSlider.addEventListener('touchend', () => { isSeeking = false; });

        row2.appendChild(progressLabel);
        row2.appendChild(progressSlider);
        row2.appendChild(timeLabel);

        // --- Row 3: Play/Pause + Autoplay + Background play ---
        const row3 = document.createElement('div');
        row3.style.display = 'flex';
        row3.style.alignItems = 'center';
        row3.style.justifyContent = 'space-between';

        playPauseBtn = document.createElement('button');
        playPauseBtn.textContent = '▶';
        playPauseBtn.title = 'Play';
        playPauseBtn.style.cursor = 'pointer';
        playPauseBtn.style.background = 'rgba(255,255,255,0.15)';
        playPauseBtn.style.border = '1px solid rgba(255,255,255,0.3)';
        playPauseBtn.style.color = '#ffffff';
        playPauseBtn.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        playPauseBtn.style.borderRadius = '4px';
        playPauseBtn.style.padding = '4px 16px';
        playPauseBtn.style.fontSize = '18px';
        playPauseBtn.style.lineHeight = '1.4';

        playPauseBtn.addEventListener('click', () => {
            if (!activeVideo) return;
            if (activeVideo.paused) {
                activeVideo.dataset.igvcUserPlay = 'true';
                activeVideo.play();
            } else {
                activeVideo._igvcForcePause = true;
                activeVideo.pause();
            }
        });

        const rightRow3 = document.createElement('div');
        rightRow3.style.display = 'flex';
        rightRow3.style.alignItems = 'center';
        rightRow3.style.gap = '10px';

        // Autoplay
        const autoplayWrapper = document.createElement('div');
        autoplayWrapper.style.display = 'flex';
        autoplayWrapper.style.alignItems = 'center';

        const autoplayLabel = document.createElement('label');
        autoplayLabel.textContent = 'Autoplay';
        autoplayLabel.style.whiteSpace = 'nowrap';
        autoplayLabel.style.color = '#ffffff';
        autoplayLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';

        const autoplayCheckbox = document.createElement('input');
        autoplayCheckbox.type = 'checkbox';
        autoplayCheckbox.checked = settings.autoplay;
        autoplayCheckbox.style.marginLeft = '4px';

        autoplayCheckbox.addEventListener('change', () => {
            settings.autoplay = autoplayCheckbox.checked;
            saveSettings();
        });
        autoplayWrapper.appendChild(autoplayLabel);
        autoplayWrapper.appendChild(autoplayCheckbox);

        // Background play
        const bgWrapper = document.createElement('div');
        bgWrapper.style.display = 'flex';
        bgWrapper.style.alignItems = 'center';

        const bgLabel = document.createElement('label');
        bgLabel.textContent = 'Bg play';
        bgLabel.title = 'Keep playing when tab is not focused';
        bgLabel.style.whiteSpace = 'nowrap';
        bgLabel.style.color = '#ffffff';
        bgLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';

        bgPlayCheckbox = document.createElement('input');
        bgPlayCheckbox.type = 'checkbox';
        bgPlayCheckbox.checked = settings.backgroundPlay;
        bgPlayCheckbox.style.marginLeft = '4px';

        bgPlayCheckbox.addEventListener('change', () => {
            settings.backgroundPlay = bgPlayCheckbox.checked;
            saveSettings();
            applyBackgroundPlayToAll();
        });
        bgWrapper.appendChild(bgLabel);
        bgWrapper.appendChild(bgPlayCheckbox);

        rightRow3.appendChild(autoplayWrapper);
        rightRow3.appendChild(bgWrapper);

        row3.appendChild(playPauseBtn);
        row3.appendChild(rightRow3);

        // --- Row 4: Speed controls ---
        const row4 = createSpeedRow();

        // --- Row 5: Boost controls ---
        const row5 = createBoostRow();

        // --- Row 6: Ad Blocker controls (toggles) ---
        const row6 = document.createElement('div');
        row6.style.display = 'flex';
        row6.style.alignItems = 'center';
        row6.style.marginBottom = '4px';
        row6.style.gap = '8px';

        adBlockEnabledCheckbox = document.createElement('input');
        adBlockEnabledCheckbox.type = 'checkbox';
        adBlockEnabledCheckbox.checked = settings.adBlockEnabled;
        adBlockEnabledCheckbox.style.marginRight = '4px';
        const adBlockLabel = document.createElement('label');
        adBlockLabel.textContent = 'Ad block:';
        adBlockLabel.style.color = '#ffffff';
        adBlockLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        adBlockLabel.style.whiteSpace = 'nowrap';

        adBlockEnabledCheckbox.addEventListener('change', () => {
            settings.adBlockEnabled = adBlockEnabledCheckbox.checked;
            saveSettings();
            if (settings.adBlockEnabled) {
                startAdBlockObservers();
            } else {
                stopAdBlockObservers();
            }
        });

        skipMsgCheckbox = document.createElement('input');
        skipMsgCheckbox.type = 'checkbox';
        skipMsgCheckbox.checked = settings.showSkipLogs;
        skipMsgCheckbox.style.marginRight = '4px';
        const skipMsgLabel = document.createElement('label');
        skipMsgLabel.textContent = 'Show AD skip msg:';
        skipMsgLabel.style.color = '#ffffff';
        skipMsgLabel.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        skipMsgLabel.style.whiteSpace = 'nowrap';

        skipMsgCheckbox.addEventListener('change', () => {
            settings.showSkipLogs = skipMsgCheckbox.checked;
            saveSettings();
            toggleAdMessageRow();
        });

        row6.appendChild(adBlockEnabledCheckbox);
        row6.appendChild(adBlockLabel);
        row6.appendChild(skipMsgCheckbox);
        row6.appendChild(skipMsgLabel);

        // --- Row 7: Ad skip message display (hidden by default) ---
        adMsgRow = document.createElement('div');
        adMsgRow.style.display = 'none';
        adMsgRow.style.alignItems = 'center';
        adMsgRow.style.marginBottom = '4px';

        adSkipMsgSpan = document.createElement('span');
        adSkipMsgSpan.style.color = '#ff4444';
        adSkipMsgSpan.style.fontWeight = 'bold';
        adSkipMsgSpan.style.fontSize = '11px';
        adSkipMsgSpan.style.textShadow = '0 0 2px rgba(0,0,0,0.8)';
        adSkipMsgSpan.style.wordBreak = 'break-word';
        adSkipMsgSpan.style.opacity = '0';
        adSkipMsgSpan.style.transition = 'opacity 0.5s';

        adMsgRow.appendChild(adSkipMsgSpan);

        container.appendChild(row1);
        container.appendChild(row2);
        container.appendChild(row3);
        container.appendChild(row4);
        container.appendChild(row5);
        container.appendChild(row6);
        container.appendChild(adMsgRow);
        document.body.appendChild(container);

        const ignoreElements = [
            volumeSlider, progressSlider, playPauseBtn,
            autoplayCheckbox, bgPlayCheckbox,
            customSpeedInput, ...speedButtons,
            customBoostInput, ...boostButtons,
            adBlockEnabledCheckbox, skipMsgCheckbox
        ];
        makeDraggable(container, ignoreElements);
    };

    const makeDraggable = (element, ignoreElements) => {
        let offsetX, offsetY, isDragging = false;

        element.addEventListener('mousedown', (e) => {
            if (ignoreElements.some(el => el.contains(e.target))) return;
            isDragging = true;
            offsetX = e.clientX - element.getBoundingClientRect().left;
            offsetY = e.clientY - element.getBoundingClientRect().top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        const onMouseMove = (e) => {
            if (!isDragging) return;
            element.style.left = `${e.clientX - offsetX}px`;
            element.style.top = `${e.clientY - offsetY}px`;
            element.style.right = 'auto';
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            localStorage.setItem(POS_KEY, JSON.stringify({
                top: element.style.top,
                left: element.style.left
            }));
        };
    };

    // ---- Video helpers ----
    const applySettings = (video) => {
        setVideoMuted(video, settings.muted);
        video.volume = settings.volume;
        if (settings.speed && video.playbackRate !== settings.speed) {
            try {
                video.playbackRate = settings.speed;
            } catch (e) {}
        }
    };

    const monitorVideo = (video) => {
        if (video.dataset.igvcProcessed) return;
        video.dataset.igvcProcessed = 'true';

        installMutedGuard(video);
        applySettings(video);

        if (settings.backgroundPlay) {
            enableBackgroundPlayOnVideo(video);
        }

        if (!activeVideo) setActiveVideo(video);

        video.addEventListener('play', () => {
            setActiveVideo(video);
            updatePlayButton();
        });

        video.addEventListener('pause', () => {
            updatePlayButton();
        });

        video.addEventListener('volumechange', () => applySettings(video));
        video.addEventListener('ratechange', () => {
            if (activeVideo === video) {
                updateSpeedUI();
                settings.speed = video.playbackRate;
                saveSettings();
            }
        });

        const originalPlay = video.play.bind(video);
        video.play = function () {
            const isFirstPlay = !video.dataset.igvcStarted;

            if (!settings.autoplay && !video.dataset.igvcUserPlay) {
                setActiveVideo(video);
                if (isFirstPlay) {
                    video.dataset.igvcStarted = 'true';
                    resetToStart(video);
                }
                return Promise.resolve();
            }

            delete video.dataset.igvcUserPlay;

            if (isFirstPlay) {
                video.dataset.igvcStarted = 'true';
                resetToStart(video);
            }

            const result = originalPlay();
            result.then(() => applySettings(video)).catch(() => {});
            return result;
        };
    };

    const applySettingsToAll = () => {
        document.querySelectorAll('video').forEach(applySettings);
    };

    const applyToAllVideos = () => {
        document.querySelectorAll('video').forEach(monitorVideo);
    };

    const init = () => {
        createControlUI();
        applyToAllVideos();
        applyBackgroundPlayToAll();
        updateSpeedUI();
        updateBoostUI();

        // Start ad blocker immediately – no delay
        if (settings.adBlockEnabled) {
            startAdBlockObservers();
        }

        const observer = new MutationObserver(debounce(() => {
            applyToAllVideos();
            applyBackgroundPlayToAll();
            updateSpeedUI();
            updateBoostUI();
        }, 300));
        observer.observe(document.body, { childList: true, subtree: true });
    };

    init();
})();
