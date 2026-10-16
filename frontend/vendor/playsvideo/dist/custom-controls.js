const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// --- SVG Icons (24x24 viewBox, white fill) ---
const svg = (d, vb = '0 0 24 24') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="currentColor">${d}</svg>`;
const ICON = {
    play: svg('<path d="M8 5v14l11-7z"/>'),
    pause: svg('<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>'),
    skipBack: svg('<path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="16.5" text-anchor="middle" font-size="7.5" font-weight="700" font-family="sans-serif" fill="currentColor">10</text>'),
    skipFwd: svg('<path d="M12.01 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="12" y="16.5" text-anchor="middle" font-size="7.5" font-weight="700" font-family="sans-serif" fill="currentColor">10</text>'),
    volumeHigh: svg('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.14v7.72c1.48-.73 2.5-2.25 2.5-3.86zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>'),
    volumeMuted: svg('<path d="M16.5 12A4.5 4.5 0 0014 8.14v2.72l2.44 2.44c.03-.1.06-.2.06-.3zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'),
    fsEnter: svg('<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>'),
    fsExit: svg('<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>'),
    overflow: svg('<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>'),
    cc: svg('<path d="M19 4H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-4a1 1 0 011-1h3a1 1 0 011 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 01-1 1h-3a1 1 0 01-1-1v-4a1 1 0 011-1h3a1 1 0 011 1v1z"/>'),
    speed: svg('<path d="M20.38 8.57l-1.23 1.85a8 8 0 01-.22 7.58H5.07A8 8 0 0115.58 6.85l1.85-1.23A10 10 0 003.35 19a2 2 0 001.72 1h13.85a2 2 0 001.74-1 10 10 0 00-.27-11.44zM10.59 15.41a2 2 0 002.83 0l5.66-8.49-8.49 5.66a2 2 0 000 2.83z"/>'),
    pip: svg('<path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>'),
};
const isTouch = matchMedia('(pointer: coarse)').matches;
const CONTROLS_CSS = `
.pv-video-container { position: relative; }
.pv-video-container:fullscreen, .pv-video-container.pv-pip { background: #000; }
.pv-video-container:fullscreen video, .pv-video-container.pv-pip video { width: 100%; height: 100%; object-fit: contain; }
.pv-video-container.pv-pip { width: 100vw; height: 100vh; }

/* Overlay wrapper */
.pv-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  opacity: 1;
  transition: opacity 0.3s;
  z-index: 10;
  pointer-events: none;
}
.pv-overlay.pv-hidden {
  opacity: 0;
}
.pv-overlay > * { pointer-events: auto; }
.pv-overlay.pv-hidden > *:not(.pv-tap-target) { pointer-events: none; }

/* Tap target covers entire video for touch show/hide */
.pv-tap-target {
  position: absolute;
  inset: 0;
}

/* Center play button */
.pv-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 2rem;
}
.pv-center-btn {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  background: rgba(0,0,0,0.5);
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.pv-center-btn svg { width: 40px; height: 40px; }
.pv-center-skip {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(0,0,0,0.35);
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.pv-center-skip svg { width: 26px; height: 26px; }

/* Bottom controls */
.pv-bottom {
  position: relative;
  background: linear-gradient(transparent, rgba(0,0,0,0.7));
  padding: 0 0.5rem 0.35rem;
}
.pv-seek-row {
  display: flex;
  align-items: center;
  padding: 0 0.25rem;
}
.pv-seek-wrap {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
}
.pv-buffered {
  position: absolute;
  left: 0;
  height: 3px;
  width: 0;
  background: rgba(255,255,255,0.5);
  border-radius: 2px;
  pointer-events: none;
}
.pv-seek {
  width: 100%;
  position: relative;
  z-index: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 3px;
  background: rgba(255,255,255,0.3);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
  margin: 0;
}
.pv-seek::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
}
.pv-btn-row {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0 0.25rem;
}
.pv-btn-row .pv-spacer { flex: 1; }

/* Icon buttons */
.pv-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 6px;
  line-height: 0;
  border-radius: 4px;
  flex-shrink: 0;
}
.pv-btn:hover { background: rgba(255,255,255,0.1); }
.pv-btn svg { width: 22px; height: 22px; }
.pv-btn-active { color: var(--accent, #3b82f6); }

/* Time display */
.pv-time {
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: #fff;
  padding: 0 0.25rem;
}

/* Volume slider — hidden on touch devices */
.pv-vol {
  width: 52px;
  -webkit-appearance: none;
  appearance: none;
  height: 3px;
  background: rgba(255,255,255,0.3);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
  margin: 0 2px;
}
.pv-vol::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
}
@media (pointer: coarse) {
  .pv-vol { display: none; }
}

/* Popup menu */
.pv-popup-anchor { position: relative; }
.pv-popup {
  position: absolute;
  bottom: 100%;
  right: 0;
  background: rgba(20,20,20,0.95);
  border-radius: 8px;
  padding: 0.35rem 0;
  min-width: 160px;
  margin-bottom: 0.5rem;
  box-shadow: 0 4px 12px rgba(0,0,0,0.6);
  z-index: 20;
}
.pv-popup-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  color: #fff;
  cursor: pointer;
  font-size: 0.85rem;
  white-space: nowrap;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}
.pv-popup-item:hover { background: rgba(255,255,255,0.1); }
.pv-popup-item.pv-active { color: var(--accent, #3b82f6); }
.pv-popup-item svg { width: 20px; height: 20px; flex-shrink: 0; }
.pv-popup-label { flex: 1; }
.pv-popup-value { color: rgba(255,255,255,0.5); font-size: 0.8rem; }
`;
let styleInjected = false;
function injectStyles() {
    if (styleInjected)
        return;
    const style = document.createElement('style');
    style.textContent = CONTROLS_CSS;
    document.head.appendChild(style);
    styleInjected = true;
}
function formatTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0)
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}
function iconBtn(label, iconHtml, className = 'pv-btn') {
    const btn = document.createElement('button');
    btn.className = className;
    btn.innerHTML = iconHtml;
    btn.setAttribute('aria-label', label);
    return btn;
}
export function createCustomControls(options) {
    const { video, container } = options;
    injectStyles();
    // --- Build DOM ---
    const overlay = document.createElement('div');
    overlay.className = 'pv-overlay';
    // Tap target — covers the video area for touch show/hide
    const tapTarget = document.createElement('div');
    tapTarget.className = 'pv-tap-target';
    // Center play/skip buttons
    const center = document.createElement('div');
    center.className = 'pv-center';
    const skipBackBtn = iconBtn('Skip back 10s', ICON.skipBack, 'pv-center-skip');
    const playBtn = iconBtn('Play/Pause', ICON.play, 'pv-center-btn');
    const skipFwdBtn = iconBtn('Skip forward 10s', ICON.skipFwd, 'pv-center-skip');
    center.append(skipBackBtn, playBtn, skipFwdBtn);
    // Bottom bar
    const bottom = document.createElement('div');
    bottom.className = 'pv-bottom';
    // Seek row
    const seekRow = document.createElement('div');
    seekRow.className = 'pv-seek-row';
    const seekWrap = document.createElement('div');
    seekWrap.className = 'pv-seek-wrap';
    const bufferedBar = document.createElement('div');
    bufferedBar.className = 'pv-buffered';
    const seekBar = document.createElement('input');
    seekBar.type = 'range';
    seekBar.className = 'pv-seek';
    seekBar.min = '0';
    seekBar.max = '0';
    seekBar.step = '0.1';
    seekBar.value = '0';
    seekWrap.append(bufferedBar, seekBar);
    seekRow.appendChild(seekWrap);
    // Button row
    const btnRow = document.createElement('div');
    btnRow.className = 'pv-btn-row';
    const timeDisplay = document.createElement('span');
    timeDisplay.className = 'pv-time';
    timeDisplay.textContent = '0:00 / 0:00';
    const spacer = document.createElement('span');
    spacer.className = 'pv-spacer';
    const volumeBtn = iconBtn('Mute/Unmute', ICON.volumeHigh);
    const volumeBar = document.createElement('input');
    volumeBar.type = 'range';
    volumeBar.className = 'pv-vol';
    volumeBar.min = '0';
    volumeBar.max = '1';
    volumeBar.step = '0.01';
    volumeBar.value = String(video.volume);
    const fsBtn = iconBtn('Fullscreen', ICON.fsEnter);
    // Overflow menu anchor + button
    const overflowAnchor = document.createElement('span');
    overflowAnchor.className = 'pv-popup-anchor';
    const overflowBtn = iconBtn('More options', ICON.overflow);
    overflowAnchor.appendChild(overflowBtn);
    btnRow.append(timeDisplay, spacer, volumeBtn, volumeBar, fsBtn, overflowAnchor);
    bottom.append(seekRow, btnRow);
    overlay.append(tapTarget, center, bottom);
    container.appendChild(overlay);
    // --- State ---
    let seeking = false;
    let hideTimer;
    let activePopup = null;
    const docPipSupported = typeof documentPictureInPicture !== 'undefined';
    const pipSupported = docPipSupported || document.pictureInPictureEnabled;
    // Document PiP state
    let pipWindow = null;
    let originalParent = null;
    let originalNextSibling = null;
    function exitDocumentPip() {
        if (!pipWindow)
            return;
        container.classList.remove('pv-pip');
        if (originalParent) {
            if (originalNextSibling) {
                originalParent.insertBefore(container, originalNextSibling);
            }
            else {
                originalParent.appendChild(container);
            }
        }
        pipWindow.close();
        pipWindow = null;
        originalParent = null;
        originalNextSibling = null;
    }
    async function enterDocumentPip() {
        originalParent = container.parentNode;
        originalNextSibling = container.nextSibling;
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 360;
        const scale = Math.min(640 / w, 360 / h, 1);
        pipWindow = await documentPictureInPicture.requestWindow({
            width: Math.round(w * scale),
            height: Math.round(h * scale),
        });
        // Inject styles into the PiP window
        const style = pipWindow.document.createElement('style');
        style.textContent = CONTROLS_CSS;
        pipWindow.document.head.appendChild(style);
        // Move the entire container into the PiP window
        container.classList.add('pv-pip');
        pipWindow.document.body.appendChild(container);
        // When PiP window is closed (user clicks X or programmatic), restore
        pipWindow.addEventListener('pagehide', () => exitDocumentPip());
    }
    // --- Popup helpers ---
    function closePopup() {
        if (activePopup) {
            activePopup.remove();
            activePopup = null;
        }
    }
    function openPopup(anchor, buildItems) {
        closePopup();
        const popup = document.createElement('div');
        popup.className = 'pv-popup';
        for (const item of buildItems())
            popup.appendChild(item);
        anchor.appendChild(popup);
        activePopup = popup;
    }
    function togglePopup(anchor, buildItems) {
        if (activePopup?.parentElement === anchor) {
            closePopup();
            return;
        }
        openPopup(anchor, buildItems);
    }
    // autoClose=false for items that open sub-menus
    function popupItem(label, active, onClick, iconHtml, value, autoClose = true) {
        const item = document.createElement('button');
        item.className = `pv-popup-item${active ? ' pv-active' : ''}`;
        if (iconHtml) {
            const iconSpan = document.createElement('span');
            iconSpan.innerHTML = iconHtml;
            iconSpan.style.lineHeight = '0';
            item.appendChild(iconSpan);
        }
        const labelSpan = document.createElement('span');
        labelSpan.className = 'pv-popup-label';
        labelSpan.textContent = label;
        item.appendChild(labelSpan);
        if (value) {
            const valSpan = document.createElement('span');
            valSpan.className = 'pv-popup-value';
            valSpan.textContent = value;
            item.appendChild(valSpan);
        }
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
            if (autoClose)
                closePopup();
        });
        return item;
    }
    // --- Auto-hide ---
    function resetHideTimer() {
        overlay.classList.remove('pv-hidden');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (!video.paused && !activePopup)
                overlay.classList.add('pv-hidden');
        }, 3000);
    }
    // --- Update functions ---
    function updatePlayBtn() {
        playBtn.innerHTML = video.paused ? ICON.play : ICON.pause;
    }
    function updateTime() {
        if (seeking)
            return;
        seekBar.value = String(video.currentTime);
        timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
        updateBuffered();
    }
    function updateDuration() {
        seekBar.max = String(video.duration || 0);
        updateTime();
    }
    function updateVolume() {
        volumeBar.value = String(video.muted ? 0 : video.volume);
        volumeBtn.innerHTML = video.muted || video.volume === 0 ? ICON.volumeMuted : ICON.volumeHigh;
    }
    function updateBuffered() {
        const duration = video.duration;
        if (!duration) {
            bufferedBar.style.width = '0';
            return;
        }
        let bufferedEnd = 0;
        for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime) {
                bufferedEnd = Math.max(bufferedEnd, video.buffered.end(i));
            }
        }
        bufferedBar.style.width = `${(bufferedEnd / duration) * 100}%`;
    }
    function updateFullscreenBtn() {
        fsBtn.innerHTML = document.fullscreenElement ? ICON.fsExit : ICON.fsEnter;
    }
    // --- Video event listeners ---
    const onPlay = () => {
        updatePlayBtn();
        resetHideTimer();
    };
    const onPause = () => {
        updatePlayBtn();
        overlay.classList.remove('pv-hidden');
        clearTimeout(hideTimer);
    };
    const onTimeUpdate = () => updateTime();
    const onDurationChange = () => updateDuration();
    const onVolumeChange = () => updateVolume();
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('loadedmetadata', onDurationChange);
    video.addEventListener('volumechange', onVolumeChange);
    const onProgress = () => updateBuffered();
    video.addEventListener('progress', onProgress);
    // Text track changes (for overflow menu state)
    const onTrackChange = () => { }; // menu is rebuilt each open
    video.textTracks.addEventListener('addtrack', onTrackChange);
    video.textTracks.addEventListener('removetrack', onTrackChange);
    // Legacy PiP events (for fallback path)
    const onEnterPip = () => { };
    const onLeavePip = () => { };
    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    // --- Button handlers ---
    // Play/pause — only via the center button
    const onPlayClick = (e) => {
        e.stopPropagation();
        if (video.paused)
            video.play();
        else
            video.pause();
    };
    playBtn.addEventListener('click', onPlayClick);
    // Tap target: first tap always shows controls if hidden.
    // When visible: touch hides controls, desktop click = play/pause.
    const onTapTargetClick = (e) => {
        e.stopPropagation();
        if (activePopup) {
            closePopup();
            return;
        }
        if (overlay.classList.contains('pv-hidden')) {
            // Always show controls first
            resetHideTimer();
        }
        else if (isTouch) {
            // Touch: hide controls
            overlay.classList.add('pv-hidden');
            clearTimeout(hideTimer);
        }
        else {
            // Desktop: click on video = play/pause
            if (video.paused)
                video.play();
            else
                video.pause();
        }
    };
    tapTarget.addEventListener('click', onTapTargetClick);
    // Skip
    const onSkipBack = (e) => {
        e.stopPropagation();
        video.currentTime = Math.max(0, video.currentTime - 10);
    };
    const onSkipFwd = (e) => {
        e.stopPropagation();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
    };
    skipBackBtn.addEventListener('click', onSkipBack);
    skipFwdBtn.addEventListener('click', onSkipFwd);
    // Seek bar
    const onSeekInput = () => {
        seeking = true;
        video.currentTime = Number(seekBar.value);
        timeDisplay.textContent = `${formatTime(Number(seekBar.value))} / ${formatTime(video.duration || 0)}`;
    };
    const onSeekChange = () => {
        video.currentTime = Number(seekBar.value);
        seeking = false;
    };
    seekBar.addEventListener('input', onSeekInput);
    seekBar.addEventListener('change', onSeekChange);
    // Volume
    const onVolumeBtnClick = () => {
        video.muted = !video.muted;
    };
    const onVolumeInput = () => {
        video.volume = Number(volumeBar.value);
        if (Number(volumeBar.value) > 0)
            video.muted = false;
    };
    volumeBtn.addEventListener('click', onVolumeBtnClick);
    volumeBar.addEventListener('input', onVolumeInput);
    // Fullscreen
    const onFsClick = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        }
        else {
            container.requestFullscreen();
        }
    };
    fsBtn.addEventListener('click', onFsClick);
    const onFullscreenChange = () => updateFullscreenBtn();
    document.addEventListener('fullscreenchange', onFullscreenChange);
    // Overflow menu
    const onOverflowClick = (e) => {
        e.stopPropagation();
        resetHideTimer();
        togglePopup(overflowAnchor, () => {
            const items = [];
            // Captions — only show if tracks exist
            const trackCount = video.textTracks.length;
            if (trackCount > 0) {
                let activeLang = 'Off';
                for (let i = 0; i < trackCount; i++) {
                    if (video.textTracks[i].mode === 'showing') {
                        activeLang =
                            video.textTracks[i].label || video.textTracks[i].language || `Track ${i + 1}`;
                    }
                }
                items.push(popupItem('Captions', false, () => {
                    openPopup(overflowAnchor, () => {
                        const subItems = [];
                        let anyShowing = false;
                        for (let i = 0; i < video.textTracks.length; i++) {
                            if (video.textTracks[i].mode === 'showing')
                                anyShowing = true;
                        }
                        subItems.push(popupItem('Off', !anyShowing, () => {
                            for (let i = 0; i < video.textTracks.length; i++) {
                                video.textTracks[i].mode = 'disabled';
                            }
                        }));
                        for (let i = 0; i < video.textTracks.length; i++) {
                            const track = video.textTracks[i];
                            const label = track.label || track.language || `Track ${i + 1}`;
                            subItems.push(popupItem(label, track.mode === 'showing', () => {
                                for (let j = 0; j < video.textTracks.length; j++) {
                                    video.textTracks[j].mode = 'disabled';
                                }
                                track.mode = 'showing';
                            }));
                        }
                        return subItems;
                    });
                }, ICON.cc, activeLang, false));
            }
            // Playback speed
            const rate = video.playbackRate;
            items.push(popupItem('Playback speed', false, () => {
                openPopup(overflowAnchor, () => SPEED_OPTIONS.map((r) => popupItem(`${r}x`, video.playbackRate === r, () => {
                    video.playbackRate = r;
                })));
            }, ICON.speed, `${rate === 1 ? 'Normal' : `${rate}x`}`, false));
            // PiP
            if (pipSupported) {
                const inPip = pipWindow ? true : document.pictureInPictureElement === video;
                items.push(popupItem('Picture in picture', inPip, async () => {
                    if (pipWindow) {
                        exitDocumentPip();
                    }
                    else if (docPipSupported) {
                        await enterDocumentPip();
                    }
                    else if (document.pictureInPictureElement === video) {
                        await document.exitPictureInPicture();
                    }
                    else {
                        await video.requestPictureInPicture();
                    }
                }, ICON.pip));
            }
            return items;
        });
    };
    overflowBtn.addEventListener('click', onOverflowClick);
    // Close popup on outside click
    const onDocMouseDown = (e) => {
        if (!activePopup)
            return;
        const target = e.target;
        if (!activePopup.contains(target) && !overflowBtn.contains(target)) {
            closePopup();
        }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    // Auto-hide on mouse movement (desktop only)
    const onMouseMove = () => resetHideTimer();
    container.addEventListener('mousemove', onMouseMove);
    // Init state
    updatePlayBtn();
    updateDuration();
    updateVolume();
    resetHideTimer();
    return {
        destroy() {
            exitDocumentPip();
            clearTimeout(hideTimer);
            closePopup();
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPause);
            video.removeEventListener('timeupdate', onTimeUpdate);
            video.removeEventListener('durationchange', onDurationChange);
            video.removeEventListener('loadedmetadata', onDurationChange);
            video.removeEventListener('volumechange', onVolumeChange);
            video.removeEventListener('progress', onProgress);
            video.removeEventListener('enterpictureinpicture', onEnterPip);
            video.removeEventListener('leavepictureinpicture', onLeavePip);
            video.textTracks.removeEventListener('addtrack', onTrackChange);
            video.textTracks.removeEventListener('removetrack', onTrackChange);
            playBtn.removeEventListener('click', onPlayClick);
            tapTarget.removeEventListener('click', onTapTargetClick);
            skipBackBtn.removeEventListener('click', onSkipBack);
            skipFwdBtn.removeEventListener('click', onSkipFwd);
            seekBar.removeEventListener('input', onSeekInput);
            seekBar.removeEventListener('change', onSeekChange);
            volumeBtn.removeEventListener('click', onVolumeBtnClick);
            volumeBar.removeEventListener('input', onVolumeInput);
            fsBtn.removeEventListener('click', onFsClick);
            overflowBtn.removeEventListener('click', onOverflowClick);
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            document.removeEventListener('mousedown', onDocMouseDown);
            container.removeEventListener('mousemove', onMouseMove);
            overlay.remove();
        },
    };
}
//# sourceMappingURL=custom-controls.js.map