/* ════════════════════════════════════════════════════════════════
   Trilogy HR Portal — Module Access Guard
   ----------------------------------------------------------------
   Include ONE line in the <head> of each protected module page,
   BEFORE any other script, setting the module key first:

     <script>window.HR_REQUIRED_MODULE='payroll';</script>
     <script src="/hr-guard.js"></script>

   Module keys: onboarding, records, leave, disciplinary, payroll,
                vibecheck, vibecheck_reports, reset
   (admins always pass; everyone else needs the key in their Modules list)
   ════════════════════════════════════════════════════════════════ */
(function () {
  var SESSION_KEY = 'hrportal_session';
  var PORTAL_HOME = '/index.html';
  var required    = (window.HR_REQUIRED_MODULE || '').toLowerCase();

  function deny(reason) {
    // Replace the page so protected markup never renders / flashes
    document.documentElement.innerHTML =
      '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
      '<style>body{margin:0;font-family:system-ui,Segoe UI,Arial,sans-serif;background:#1e1e1e;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:1.5rem}' +
      '.box{max-width:380px}.t{font-size:20px;font-weight:800;margin-bottom:10px}' +
      '.s{font-size:14px;color:rgba(255,255,255,.55);line-height:1.6;margin-bottom:24px}' +
      'a{display:inline-block;background:#4AFD0E;color:#111;text-decoration:none;font-weight:700;' +
      'padding:11px 22px;border-radius:8px;font-size:13px}</style></head>' +
      '<body><div class="box"><div class="t">🔒 Access restricted</div>' +
      '<div class="s">' + reason + '</div>' +
      '<a href="' + PORTAL_HOME + '">← Back to HR Portal</a></div></body>';
    // Stop any further scripts on the page from doing work
    if (window.stop) { try { window.stop(); } catch (e) {} }
  }

  var raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) {
    // Not signed in at all → send to portal to authenticate
    window.location.replace(PORTAL_HOME);
    return;
  }

  var session;
  try { session = JSON.parse(raw); }
  catch (e) { window.location.replace(PORTAL_HOME); return; }

  var role    = (session.role || '').toLowerCase();
  var modules = Array.isArray(session.modules)
    ? session.modules.map(function (m) { return String(m).toLowerCase(); })
    : [];

  // Admins pass everything
  if (role === 'admin') return;

  // No module requirement declared → allow any signed-in user
  if (!required) return;

  // Otherwise the user must have the module granted
  if (modules.indexOf(required) === -1) {
    deny('You don\'t have access to this module. If you need it, ask an HR Portal administrator to grant it.');
  }
})();
