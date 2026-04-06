let overlay = null;
let countdownInterval = null;
let countdownElement = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'block') {
    showBlockOverlay(message.message);
    removeCountdown();
  } else if (message.action === 'unblock') {
    removeBlockOverlay();
    removeCountdown();
  } else if (message.action === 'start_countdown') {
    startCountdown(message.endTime);
  } else if (message.action === 'show_paused') {
    showPaused(message.remainingMs);
  }
});

// ── Countdown (active) ────────────────────────────────────────────────────────

function startCountdown(endTimeMs) {
  removeCountdown();
  ensureCountdownElement();

  countdownInterval = setInterval(() => {
    const remainingMs = endTimeMs - Date.now();
    if (remainingMs <= 0) {
      setCountdownText('00:00');
      clearInterval(countdownInterval);
      countdownInterval = null;
    } else {
      setCountdownText(formatMs(remainingMs));
    }
  }, 500);
}

// ── Paused display ────────────────────────────────────────────────────────────

function showPaused(remainingMs) {
  removeCountdown();
  ensureCountdownElement();
  setCountdownText(`${formatMs(remainingMs)} ⏸`);
}

// ── Countdown element helpers ─────────────────────────────────────────────────

function ensureCountdownElement() {
  if (countdownElement) return;
  countdownElement = document.createElement('div');
  countdownElement.id = 'site-blocker-countdown';
  Object.assign(countdownElement.style, {
    position:        'fixed',
    bottom:          '16px',
    right:           '16px',
    backgroundColor: 'rgba(15,15,19,0.85)',
    color:           '#e8e8f0',
    padding:         '8px 14px',
    borderRadius:    '10px',
    fontFamily:      'monospace',
    fontSize:        '13px',
    fontWeight:      'bold',
    zIndex:          '2147483646',
    boxShadow:       '0 2px 12px rgba(0,0,0,0.4)',
    border:          '1px solid rgba(124,106,247,0.3)',
    userSelect:      'none',
    backdropFilter:  'blur(8px)',
  });
  document.body.appendChild(countdownElement);
}

function setCountdownText(text) {
  if (countdownElement) countdownElement.textContent = text;
}

function formatMs(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function removeCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (countdownElement)  { countdownElement.remove(); countdownElement = null; }
}

// ── Block overlay (full page takeover) ───────────────────────────────────────

function showBlockOverlay(msg) {
  if (overlay) return;

  const ensureBody = () => {
    if (!document.body) { setTimeout(ensureBody, 50); return; }

    // Load fonts
    if (!document.getElementById('clocked-fonts')) {
      const fontLink = document.createElement('link');
      fontLink.id   = 'clocked-fonts';
      fontLink.rel  = 'stylesheet';
      fontLink.href = 'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap';
      document.head.appendChild(fontLink);
    }

    // Keyframes + hover styles (injected once)
    if (!document.getElementById('clocked-styles')) {
      const style = document.createElement('style');
      style.id = 'clocked-styles';
      style.textContent = `
        @keyframes fg-fade    { from { opacity:0 } to { opacity:1 } }
        @keyframes fg-up      { from { opacity:0; transform:translateY(28px) } to { opacity:1; transform:translateY(0) } }
        @keyframes fg-drift-a { 0%{transform:translate(0,0) scale(1)} 50%{transform:translate(40px,-30px) scale(1.06)} 100%{transform:translate(0,0) scale(1)} }
        @keyframes fg-drift-b { 0%{transform:translate(0,0) scale(1)} 50%{transform:translate(-30px,20px) scale(0.95)} 100%{transform:translate(0,0) scale(1)} }
        @keyframes fg-drift-c { 0%{transform:translate(0,0)} 50%{transform:translate(20px,30px)} 100%{transform:translate(0,0)} }
        @keyframes fg-pulse   { 0%{transform:scale(1);opacity:.5} 100%{transform:scale(1.6);opacity:0} }
        #clocked-btn:hover  { background:#9d8ffa !important; transform:translateY(-2px) !important; box-shadow:0 10px 36px rgba(124,106,247,.5) !important; }
        #clocked-btn:active { transform:translateY(0) !important; }
      `;
      document.head.appendChild(style);
    }

    // Root overlay — covers the entire viewport
    overlay = document.createElement('div');
    overlay.id = 'site-blocker-overlay';
    Object.assign(overlay.style, {
      position:       'fixed',
      inset:          '0',
      zIndex:         '2147483647',
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      overflow:       'hidden',
      background:     '#090910',
      animation:      'fg-fade 0.4s ease forwards',
    });

    // ── Ambient blobs ─────────────────────────────────────────────────────────
    const blobs = [
      { color:'rgba(124,106,247,0.13)', size:'700px', top:'-180px',  left:'-180px',  anim:'fg-drift-a 22s ease-in-out infinite' },
      { color:'rgba(247,90,106,0.10)',  size:'550px', bottom:'-120px',right:'-100px', anim:'fg-drift-b 18s ease-in-out infinite' },
      { color:'rgba(74,222,128,0.06)',  size:'420px', top:'55%',     left:'38%',      anim:'fg-drift-c 26s ease-in-out infinite' },
    ];
    blobs.forEach(b => {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position:     'absolute',
        width:        b.size, height: b.size,
        borderRadius: '50%',
        background:   b.color,
        filter:       'blur(90px)',
        animation:    b.anim,
        pointerEvents:'none',
      });
      if (b.top)    el.style.top    = b.top;
      if (b.left)   el.style.left   = b.left;
      if (b.bottom) el.style.bottom = b.bottom;
      if (b.right)  el.style.right  = b.right;
      overlay.appendChild(el);
    });

    // Subtle grid lines
    const grid = document.createElement('div');
    Object.assign(grid.style, {
      position:        'absolute',
      inset:           '0',
      backgroundImage: 'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
      backgroundSize:  '64px 64px',
      pointerEvents:   'none',
      maskImage:       'radial-gradient(ellipse 80% 80% at 50% 50%, black 30%, transparent 100%)',
    });
    overlay.appendChild(grid);

    // ── Content card ──────────────────────────────────────────────────────────
    const card = document.createElement('div');
    Object.assign(card.style, {
      position:       'relative',
      zIndex:         '2',
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      textAlign:      'center',
      padding:        '0 32px',
      maxWidth:       '560px',
      width:          '100%',
      fontFamily:     "'DM Sans', sans-serif",
    });

    // Icon with pulse rings
    const iconWrap = document.createElement('div');
    Object.assign(iconWrap.style, {
      position:     'relative',
      width:        '80px', height: '80px',
      marginBottom: '40px',
      animation:    'fg-up 0.55s 0.05s ease both',
    });
    [0, 1].forEach(i => {
      const ring = document.createElement('div');
      Object.assign(ring.style, {
        position:     'absolute',
        inset:        '-14px',
        borderRadius: '50%',
        border:       '1px solid rgba(247,90,106,0.35)',
        animation:    `fg-pulse 2.6s ${i * 1.3}s ease-out infinite`,
        pointerEvents:'none',
      });
      iconWrap.appendChild(ring);
    });
    const iconInner = document.createElement('div');
    Object.assign(iconInner.style, {
      position:       'absolute',
      inset:          '0',
      borderRadius:   '50%',
      background:     'radial-gradient(circle at 40% 35%, rgba(247,90,106,0.3), rgba(247,90,106,0.08))',
      border:         '1px solid rgba(247,90,106,0.4)',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      fontSize:       '32px',
    });
    iconInner.textContent = '⏱';
    iconWrap.appendChild(iconInner);
    card.appendChild(iconWrap);

    // Eyebrow
    const eyebrow = document.createElement('p');
    eyebrow.textContent = 'CLOCKED';
    Object.assign(eyebrow.style, {
      color:         'rgba(247,90,106,0.75)',
      fontSize:      '11px',
      fontWeight:    '600',
      letterSpacing: '4px',
      marginBottom:  '16px',
      animation:     'fg-up 0.55s 0.12s ease both',
    });
    card.appendChild(eyebrow);

    // Headline
    const h1 = document.createElement('h1');
    h1.textContent = "Time's Up.";
    Object.assign(h1.style, {
      fontFamily:    "'Syne', sans-serif",
      fontSize:      'clamp(56px, 9vw, 88px)',
      fontWeight:    '800',
      color:         '#f0f0fa',
      lineHeight:    '1',
      letterSpacing: '-3px',
      marginBottom:  '24px',
      animation:     'fg-up 0.55s 0.18s ease both',
    });
    card.appendChild(h1);

    // Subtitle
    const sub = document.createElement('p');
    sub.textContent = "You've reached your time limit for this site. Close the tab and go do something great.";
    Object.assign(sub.style, {
      color:         'rgba(232,232,240,0.45)',
      fontSize:      '16px',
      lineHeight:    '1.65',
      maxWidth:      '400px',
      marginBottom:  '52px',
      animation:     'fg-up 0.55s 0.24s ease both',
    });
    card.appendChild(sub);

    // Thin rule
    const rule = document.createElement('div');
    Object.assign(rule.style, {
      width:         '1px',
      height:        '48px',
      background:    'linear-gradient(to bottom, transparent, rgba(255,255,255,0.1), transparent)',
      marginBottom:  '52px',
      animation:     'fg-up 0.55s 0.28s ease both',
    });
    card.appendChild(rule);

    // CTA button
    const btn = document.createElement('button');
    btn.id = 'clocked-btn';
    btn.textContent = 'Close Tab';
    Object.assign(btn.style, {
      padding:       '15px 48px',
      background:    '#7c6af7',
      color:         '#fff',
      border:        'none',
      borderRadius:  '14px',
      fontSize:      '15px',
      fontWeight:    '600',
      fontFamily:    "'DM Sans', sans-serif",
      letterSpacing: '0.2px',
      cursor:        'pointer',
      boxShadow:     '0 4px 24px rgba(124,106,247,0.35)',
      transition:    'background 0.2s, transform 0.15s, box-shadow 0.2s',
      animation:     'fg-up 0.55s 0.34s ease both',
    });
    btn.addEventListener('click', () => {
      removeBlockOverlay();
      chrome.runtime.sendMessage({ action: 'closeTab' });
    });
    card.appendChild(btn);

    overlay.appendChild(card);

    // ── Bottom site label ─────────────────────────────────────────────────────
    const siteBadge = document.createElement('div');
    siteBadge.textContent = window.location.hostname;
    Object.assign(siteBadge.style, {
      position:      'absolute',
      bottom:        '28px',
      left:          '50%',
      transform:     'translateX(-50%)',
      zIndex:        '2',
      color:         'rgba(232,232,240,0.18)',
      fontSize:      '12px',
      fontFamily:    'monospace',
      letterSpacing: '1px',
      animation:     'fg-fade 1s 0.6s ease both',
      opacity:       '0',
    });
    overlay.appendChild(siteBadge);

    document.body.appendChild(overlay);
  };

  ensureBody();
}

function removeBlockOverlay() {
  if (overlay) { overlay.remove(); overlay = null; }
}