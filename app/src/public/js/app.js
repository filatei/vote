/* Progressive enhancement only. Every flow works without JavaScript;
   this just adds convenience. No external dependencies. */
(function () {
  'use strict';

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
      var t = initial[i].querySelector('.lb-thumb');
      if (oid && t) thumbs[oid] = t.outerHTML;
    }
    function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
    function render(data) {
      var rows = data.rows.slice().sort(function (a, b) { return b.votes - a.votes; });
      var total = rows.reduce(function (s, r) { return s + r.votes; }, 0);
      var maxv = rows.length ? rows[0].votes : 0;
      var html = '';
      rows.forEach(function (r, idx) {
        var pct = total ? Math.round((r.votes / total) * 100) : 0;
        var bar = maxv ? Math.round((r.votes / maxv) * 100) : 0;
        var leader = idx === 0 && r.votes > 0;
        html += '<li class="lb-row' + (leader ? ' lb-leader' : '') + '" data-option-id="' + r.option_id + '">' +
          '<span class="lb-rank">' + (idx + 1) + '</span>' + (thumbs[r.option_id] || '') +
          '<div class="lb-main"><div class="lb-top">' +
          '<span class="lb-name">' + esc(r.label) + (leader ? ' <span class="lb-badge">Leading</span>' : '') + '</span>' +
          '<span class="lb-votes">' + r.votes + '<span class="lb-pct">' + pct + '%</span></span>' +
          '</div><div class="bar"><div class="bar-fill" style="width:' + bar + '%"></div></div></div></li>';
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
