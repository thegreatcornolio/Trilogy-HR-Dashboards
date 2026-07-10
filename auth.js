// ─────────────────────────────────────────────
// Trilogy HomeBase — Shared Auth Module v1.0
// Include this on every sub-portal page BEFORE
// any other scripts.
//
// Usage:
//   <script src="/auth.js"></script>
//   <script>
//     HomeBaseAuth.require('hr'); // or 'recruitment','payroll','it','mis'
//   </script>
// ─────────────────────────────────────────────

(function(window){
  var SESSION_KEY = 'homebase_session';
  var HOME_URL    = 'https://home.trilogybpo.com';

  function getSession(){
    try{
      var s = sessionStorage.getItem(SESSION_KEY);
      return s ? JSON.parse(s) : null;
    }catch(e){ return null; }
  }

  function isAdmin(session){
    return session && session.role === 'admin';
  }

  function hasModule(session, module){
    if(!session) return false;
    if(isAdmin(session)) return true;
    var mods = (session.modules || '').split(',').map(function(m){ return m.trim(); });
    return mods.indexOf(module) > -1;
  }

  // Call this at the top of every sub-portal page.
  // module: 'hr' | 'recruitment' | 'payroll' | 'it' | 'mis'
  // If no valid session or no access → redirect to home
  function require(module){
    var session = getSession();
    if(!session){
      window.location.replace(HOME_URL + '?redirect=' + encodeURIComponent(window.location.href));
      return null;
    }
    if(!hasModule(session, module)){
      window.location.replace(HOME_URL + '?denied=' + module);
      return null;
    }
    return session;
  }

  // Returns session if valid, null if not (no redirect)
  function peek(){
    return getSession();
  }

  // Set session (called by HomeBase index after login)
  function setSession(data){
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  // Clear session (logout)
  function clearSession(){
    sessionStorage.removeItem(SESSION_KEY);
  }

  window.HomeBaseAuth = {
    require:      require,
    peek:         peek,
    setSession:   setSession,
    clearSession: clearSession,
    isAdmin:      isAdmin,
    hasModule:    hasModule,
    getSession:   getSession,
    SESSION_KEY:  SESSION_KEY,
    HOME_URL:     HOME_URL
  };

})(window);
