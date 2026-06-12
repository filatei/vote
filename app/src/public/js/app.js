/* Progressive enhancement only. Every flow works without JavaScript;
   this just adds convenience. No external dependencies. */
(function () {
  'use strict';

  // 0. Register the service worker (installable PWA / app-like experience).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* ignore */ });
    });
  }

  // 1. New-election form: toggle "max selections" + add/remove option rows.
  var ballotToggles = document.querySelectorAll('[data-ballot-toggle]');
  var maxWrap = document.querySelector('[data-max-wrap]');
  function syncMax() {
    var multiple = document.querySelector('[data-ballot-toggle][value="multiple"]');
    if (maxWrap && multiple) {
      if (multiple.checked) { maxWrap.removeAttribute('hidden'); }
      else { maxWrap.setAttribute('hidden', ''); }
    }
  }
  for (var i = 0; i < ballotToggles.length; i++) {
    ballotToggles[i].addEventListener('change', syncMax);
  }
  syncMax();

  var addOption = document.getElementById('add-option');
  var optionsList = document.getElementById('options-list');
  if (addOption && optionsList) {
    addOption.addEventListener('click', function () {
      if (optionsList.querySelector('.option-edit-row')) {
        // Edit form: paired hidden id + label + remove button.
        var row = document.createElement('div');
        row.className = 'option-edit-row';
        row.innerHTML =
          '<input type="hidden" name="optionId" value="" />' +
          '<input class="option-input" type="text" name="option" maxlength="200" placeholder="Candidate name" />' +
          '<button type="button" class="button button-ghost option-remove" aria-label="Remove">×</button>';
        optionsList.appendChild(row);
        row.querySelector('.option-input').focus();
      } else {
        var input = document.createElement('input');
        input.className = 'option-input';
        input.type = 'text';
        input.name = 'option';
        input.maxLength = 200;
        input.placeholder = 'Option label';
        optionsList.appendChild(input);
        input.focus();
      }
    });
    optionsList.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.option-remove') : null;
      if (btn) {
        var row = btn.closest('.option-edit-row');
        if (row) row.remove();
      }
    });
  }

  // 2. Ballot page: highlight selected candidate cards (both radio + checkbox)
  //    and enforce max selections for approval voting + live hint.
  var ballotForm = document.querySelector('.ballot-form');
  if (ballotForm) {
    var type = ballotForm.getAttribute('data-ballot-type');
    var max = parseInt(ballotForm.getAttribute('data-max'), 10) || 1;
    var hint = ballotForm.querySelector('[data-selection-hint]');
    var inputs = ballotForm.querySelectorAll('input[name="option"]');
    var update = function () {
      var checked = ballotForm.querySelectorAll('input[name="option"]:checked').length;
      for (var j = 0; j < inputs.length; j++) {
        var inp = inputs[j];
        var lab = inp.closest('.option');
        if (lab) lab.classList.toggle('is-selected', inp.checked);
        if (type === 'multiple') {
          var dis = !inp.checked && checked >= max;
          inp.disabled = dis;
          if (lab) lab.classList.toggle('is-disabled', dis);
        }
      }
      if (type === 'multiple' && hint) {
        hint.hidden = false;
        hint.textContent = checked + ' of ' + max + ' selected';
      }
    };
    for (var k = 0; k < inputs.length; k++) inputs[k].addEventListener('change', update);
    update();
  }

  // 2b. Confirm destructive actions (delete election).
  var confirmForms = document.querySelectorAll('[data-confirm]');
  for (var c = 0; c < confirmForms.length; c++) {
    confirmForms[c].addEventListener('submit', function (e) {
      if (!window.confirm(this.getAttribute('data-confirm'))) {
        e.preventDefault();
      }
    });
  }

  // 2c. Contestant bio toggle (tap/click) — hover is handled by CSS.
  var bioToggles = document.querySelectorAll('.bio-toggle');
  for (var b2 = 0; b2 < bioToggles.length; b2++) {
    bioToggles[b2].addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var opt = this.closest('.option');
      if (!opt) return;
      var open = opt.classList.toggle('bio-open');
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // 2d. Copy-to-clipboard buttons (share link, etc).
  function copyText(text, btn) {
    var done = function () {
      var orig = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', orig);
      btn.textContent = 'Copied ✓';
      setTimeout(function () { btn.textContent = orig; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
  }
  var copyButtons = document.querySelectorAll('[data-copy-btn]');
  for (var ci = 0; ci < copyButtons.length; ci++) {
    copyButtons[ci].addEventListener('click', function () {
      var field = this.closest('.copy-field') || document;
      var input = field.querySelector('[data-copy]');
      if (input) {
        input.focus();
        input.select();
        copyText(input.value, this);
      }
    });
  }

  // 2d-ii. Tap-to-copy elements (e.g. the receipt code).
  var tapCopies = document.querySelectorAll('[data-copy-tap]');
  for (var ti = 0; ti < tapCopies.length; ti++) {
    tapCopies[ti].addEventListener('click', function () {
      var text = (this.getAttribute('data-copy-value') || this.textContent || '').trim();
      copyText(text, this);
    });
  }

  // 2e-i. Tap a leaderboard candidate to reveal their bio (delegated so it
  //       keeps working after the live poll re-renders the list).
  var board = document.querySelector('.leaderboard');
  if (board) {
    board.addEventListener('click', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.lb-row') : null;
      if (row && row.classList.contains('has-bio')) row.classList.toggle('bio-open');
    });
  }

  // 2e. Live tally streaming on the public results page.
  (function () {
    var ol = document.querySelector('[data-results-poll]');
    if (!ol || !ol.hasAttribute('data-poll')) return;
    var pid = ol.getAttribute('data-public-id');
    var countEl = document.querySelector('[data-ballot-count]');
    var thumbs = {};
    var initial = ol.querySelectorAll('.lb-row');
    for (var i = 0; i < initial.length; i++) {
      var oid = initial[i].getAttribute('data-option-id');
      // Capture the whole photo wrapper (thumbnail + optional party flag) so it
      // survives the live re-render below.
      var t = initial[i].querySelector('.lb-photo') || initial[i].querySelector('.lb-thumb');
      if (oid && t) thumbs[oid] = t.outerHTML;
    }
    function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
    function render(data) {
      // Preserve which bios are open across re-renders.
      var open = {};
      var cur = ol.querySelectorAll('.lb-row.bio-open');
      for (var c = 0; c < cur.length; c++) open[cur[c].getAttribute('data-option-id')] = true;

      var rows = data.rows.slice().sort(function (a, b) { return b.votes - a.votes; });
      var total = rows.reduce(function (s, r) { return s + r.votes; }, 0);
      var maxv = rows.length ? rows[0].votes : 0;
      var html = '';
      rows.forEach(function (r, idx) {
        var pct = total ? Math.round((r.votes / total) * 100) : 0;
        var bar = maxv ? Math.round((r.votes / maxv) * 100) : 0;
        var leader = idx === 0 && r.votes > 0;
        var hasBio = !!(r.description && String(r.description).trim());
        var cls = 'lb-row' + (leader ? ' lb-leader' : '') + (hasBio ? ' has-bio' : '') +
          (open[r.option_id] ? ' bio-open' : '');
        html += '<li class="' + cls + '" data-option-id="' + r.option_id + '">' +
          '<span class="lb-rank">' + (idx + 1) + '</span>' + (thumbs[r.option_id] || '') +
          '<div class="lb-main"><div class="lb-top">' +
          '<span class="lb-name">' + esc(r.label) + (leader ? ' <span class="lb-badge">Leading</span>' : '') +
          (hasBio ? ' <span class="lb-caret" aria-hidden="true">▾</span>' : '') + '</span>' +
          '<span class="lb-votes">' + r.votes + '<span class="lb-pct">' + pct + '%</span></span>' +
          '</div><div class="bar"><div class="bar-fill" style="width:' + bar + '%"></div></div>' +
          (hasBio ? '<div class="lb-bio">' + esc(r.description) + '</div>' : '') +
          '</div></li>';
      });
      ol.innerHTML = html;
      if (countEl) countEl.textContent = data.totalBallots;
    }
    var timer = null;
    function poll() {
      fetch('/e/' + encodeURIComponent(pid) + '/results.json', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || data.hidden || !data.rows) return;
          render(data);
          if (data.status !== 'open' && timer) { clearInterval(timer); timer = null; }
        })
        .catch(function () { /* ignore transient errors */ });
    }
    function start() { if (!timer) timer = setInterval(poll, 4000); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    start();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else { start(); poll(); }
    });
  })();

  // 2f. YouTube facade → swap in the real player only when the user asks for it.
  //     Keeps the landing page instant (just a thumbnail) until play is clicked.
  var facades = document.querySelectorAll('.yt-facade');
  function playFacade(el) {
    if (el.classList.contains('is-playing')) return;
    var src = el.getAttribute('data-yt-embed');
    if (!src) return;
    var iframe = document.createElement('iframe');
    iframe.src = src + (src.indexOf('?') > -1 ? '&' : '?') + 'autoplay=1';
    iframe.title = 'Torama Vote — explainer';
    iframe.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    el.innerHTML = '';
    el.appendChild(iframe);
    el.classList.add('is-playing');
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
  }
  for (var f = 0; f < facades.length; f++) {
    (function (el) {
      el.addEventListener('click', function () { playFacade(el); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          playFacade(el);
        }
      });
    })(facades[f]);
  }

  // 2g. Contestant editor: keep each Save button disabled until that form has an
  //     actual change (photo chosen, bio edited, or "remove photo" toggled).
  var contestantForms = document.querySelectorAll('[data-contestant-form]');
  for (var cf = 0; cf < contestantForms.length; cf++) {
    (function (form) {
      var save = form.querySelector('[data-save]');
      if (!save) return;
      save.disabled = true;
      var enable = function () { save.disabled = false; };
      form.addEventListener('input', enable);   // textarea typing
      form.addEventListener('change', enable);   // file pick + checkbox
    })(contestantForms[cf]);
  }

  // 3. One-time codes view: copy-all button.
  var copyBtn = document.getElementById('copy-codes');
  var dump = document.getElementById('code-dump');
  if (copyBtn && dump && navigator.clipboard) {
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(dump.textContent.trim()).then(function () {
        var original = copyBtn.textContent;
        copyBtn.textContent = 'Copied ✓';
        setTimeout(function () { copyBtn.textContent = original; }, 1500);
      });
    });
  }
})();
