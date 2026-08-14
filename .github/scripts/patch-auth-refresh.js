const fs = require('fs');
const path = 'admin-workstation.html';
let s = fs.readFileSync(path, 'utf8');

const oldAuth = `    const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    let currentToken = null;
    let casesData = [];
    let currentView = 'dashboard';
    let currentQueueFilter = 'all';
    let selectedCaseId = null;

    checkAuth();

    async function checkAuth() {
      const { data: { session } } = await db.auth.getSession();
      if (session) {
        currentToken = session.access_token;
        document.getElementById('login').style.display = 'none';
        await fetchCases();
      }
    }
`;

const newAuth = `    const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    let currentToken = null;
    let casesData = [];
    let currentView = 'dashboard';
    let currentQueueFilter = 'all';
    let selectedCaseId = null;

    db.auth.onAuthStateChange((event, session) => {
      currentToken = session?.access_token || null;
      if (event === 'SIGNED_OUT') {
        selectedCaseId = null;
        $('login').style.display = 'flex';
      }
    });

    checkAuth();

    async function checkAuth() {
      try {
        const token = await getFreshAccessToken();
        if (token) {
          document.getElementById('login').style.display = 'none';
          await fetchCases();
        }
      } catch (e) {
        currentToken = null;
        $('login').style.display = 'flex';
      }
    }
`;

if (!s.includes(oldAuth)) throw new Error('Auth initialization block not found');
s = s.replace(oldAuth, newAuth);

const oldHeaders = `    function headers() {
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentToken };
    }
`;

const newHeaders = `    async function getFreshAccessToken(forceRefresh = false) {
      let result = forceRefresh ? await db.auth.refreshSession() : await db.auth.getSession();
      let session = result.data?.session || null;
      let error = result.error || null;

      if (!error && session && !forceRefresh) {
        const expiresAtMs = Number(session.expires_at || 0) * 1000;
        if (expiresAtMs && expiresAtMs - Date.now() < 60000) {
          result = await db.auth.refreshSession();
          session = result.data?.session || null;
          error = result.error || null;
        }
      }

      if (error || !session?.access_token) {
        throw new Error('SESSION_EXPIRED');
      }

      currentToken = session.access_token;
      return currentToken;
    }

    async function expireSessionUi() {
      currentToken = null;
      selectedCaseId = null;
      $('login').style.display = 'flex';
      toast('Your session has expired. Please sign in again. Your work has not been lost.');
    }

    async function authFetch(url, options = {}) {
      const request = async (forceRefresh = false) => {
        const token = await getFreshAccessToken(forceRefresh);
        const requestHeaders = { ...(options.headers || {}), 'Authorization': 'Bearer ' + token };
        if (options.body !== undefined && !requestHeaders['Content-Type']) requestHeaders['Content-Type'] = 'application/json';
        return fetch(url, { ...options, headers: requestHeaders });
      };

      let response;
      try {
        response = await request(false);
        if (response.status === 401) response = await request(true);
      } catch (error) {
        if (error.message === 'SESSION_EXPIRED') {
          await expireSessionUi();
          throw new Error('Your session has expired. Please sign in again.');
        }
        throw error;
      }

      if (response.status === 401) {
        await expireSessionUi();
        throw new Error('Your session has expired. Please sign in again.');
      }

      return response;
    }

    function headers() {
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentToken };
    }
`;

if (!s.includes(oldHeaders)) throw new Error('headers block not found');
s = s.replace(oldHeaders, newHeaders);

const before = (s.match(/fetch\('\/.netlify\/functions\//g) || []).length;
s = s.replace(/fetch\('\/.netlify\/functions\//g, "authFetch('/.netlify/functions/");
const after = (s.match(/fetch\('\/.netlify\/functions\//g) || []).length;
const authCalls = (s.match(/authFetch\('\/.netlify\/functions\//g) || []).length;
if (!before) throw new Error('No protected Netlify fetch calls found');
if (after !== 0) throw new Error('Not all protected Netlify fetch calls were converted');
if (authCalls < before) throw new Error('Protected fetch conversion count mismatch');

fs.writeFileSync(path, s);
console.log(`Converted ${before} protected function calls to authFetch.`);
