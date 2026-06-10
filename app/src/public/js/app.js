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
      var input = document.createElement('input');
      input.className = 'option-input';
      input.type = 'text';
      input.name = 'option';
      input.maxLength = 200;
      input.placeholder = 'Option label';
      optionsList.appendChild(input);
      input.focus();
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
