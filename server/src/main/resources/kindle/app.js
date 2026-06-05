(function () {
  var APP_ROOT = getAppRoot();
  var GRAPHQL_URL = APP_ROOT + 'api/graphql';
  var REST_ROOT = APP_ROOT + 'api/v1/';
  var STORAGE_PREFIX = 'suwayomi-kindle:';
  var POLL_INTERVAL = 15000;

  var state = {
    server: null,
    accessToken: readSetting('accessToken'),
    refreshToken: readSetting('refreshToken'),
    message: '',
    messageType: '',
    query: '',
      sortBy: 'TITLE',
      sortDir: 'ASC',
    library: [],
    manga: null,
    chapters: [],
    downloads: null,
    downloadMap: {},
    reader: null,
    activeRouteKey: '',
    refreshPending: false,
  };

  var loginMutation = 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken refreshToken } }';
  var refreshMutation = 'mutation Refresh($input: RefreshTokenInput!) { refreshToken(input: $input) { accessToken } }';
  var aboutServerQuery = 'query AboutServer { aboutServer { name version buildType } }';
  var libraryQuery = 'query Library($condition: MangaConditionInput, $orderBy: MangaOrderBy, $orderByType: SortOrder, $first: Int) { mangas(condition: $condition, orderBy: $orderBy, orderByType: $orderByType, first: $first) { totalCount nodes { id title author artist description thumbnailUrl unreadCount bookmarkCount downloadCount lastFetchedAt firstUnreadChapter { id } lastReadChapter { id } } } }';
  var mangaQuery = 'query Manga($id: Int!) { manga(id: $id) { id title author artist description thumbnailUrl inLibrary unreadCount bookmarkCount downloadCount firstUnreadChapter { id } lastReadChapter { id } } chapters(condition: { mangaId: $id }, order: [{ by: SOURCE_ORDER, byType: DESC }], first: 500) { totalCount nodes { id mangaId sourceOrder name chapterNumber uploadDate isRead isBookmarked lastPageRead pageCount isDownloaded } } }';
  var chapterQuery = 'query Chapter($id: Int!) { chapter(id: $id) { id mangaId sourceOrder name chapterNumber uploadDate isRead isBookmarked lastPageRead pageCount isDownloaded manga { id title thumbnailUrl } } }';
  var readerChapterQuery = 'query ReaderChapter($id: Int!) { chapter(id: $id) { id mangaId sourceOrder name chapterNumber uploadDate isRead isBookmarked lastPageRead pageCount isDownloaded manga { id title thumbnailUrl } } }';
  var downloadStatusQuery = 'query DownloadStatus { downloadStatus { state queue { chapter { id mangaId sourceOrder name chapterNumber isRead isBookmarked lastPageRead pageCount isDownloaded manga { id title } } state progress tries position } } }';
  var updateChapterMutation = 'mutation UpdateChapter($input: UpdateChapterInput!) { updateChapter(input: $input) { chapter { id isRead isBookmarked lastPageRead pageCount } } }';
  var updateChaptersMutation = 'mutation UpdateChapters($input: UpdateChaptersInput!) { updateChapters(input: $input) { chapters { id isRead isBookmarked lastPageRead pageCount } } }';
  var enqueueChapterDownloadMutation = 'mutation EnqueueChapterDownload($input: EnqueueChapterDownloadInput!) { enqueueChapterDownload(input: $input) { downloadStatus { state } } }';
  var dequeueChapterDownloadMutation = 'mutation DequeueChapterDownload($input: DequeueChapterDownloadInput!) { dequeueChapterDownload(input: $input) { downloadStatus { state } } }';
  var startDownloaderMutation = 'mutation StartDownloader($input: StartDownloaderInput!) { startDownloader(input: $input) { downloadStatus { state } } }';
  var stopDownloaderMutation = 'mutation StopDownloader($input: StopDownloaderInput!) { stopDownloader(input: $input) { downloadStatus { state } } }';
  var clearDownloaderMutation = 'mutation ClearDownloader($input: ClearDownloaderInput!) { clearDownloader(input: $input) { downloadStatus { state } } }';

  var appNode = null;
  var bannerNode = null;
  var serverNode = null;
  var pollTimer = null;

  window.KindleApp = {
    login: login,
    logout: logout,
    setQuery: setQuery,
    setSort: setSort,
    openLibrary: function () { go('#/library'); return false; },
    openDownloads: function () { go('#/downloads'); return false; },
    openManga: function (id) { go('#/manga/' + id); return false; },
    resumeManga: resumeManga,
    openReader: function (chapterId, page) { go('#/reader/' + chapterId + '/' + page); return false; },
    prevPage: prevPage,
    nextPage: nextPage,
    markRead: markRead,
    toggleBookmark: toggleBookmark,
    toggleDownload: toggleDownload,
    startDownloader: startDownloader,
    stopDownloader: stopDownloader,
    clearDownloads: clearDownloads,
    refreshCurrent: refreshCurrent,
  };

  init();

  function init() {
    appNode = document.getElementById('app');
    bannerNode = document.getElementById('banner');
    serverNode = document.getElementById('server-info');

    setServerInfo('Connecting...');
    bindHashEvents();
    loadServerInfo(function () {
      route();
      pollTimer = window.setInterval(function () {
        if (state.accessToken || state.refreshToken) {
          loadDownloadStatus(false);
        }
      }, POLL_INTERVAL);
    });
  }

  function bindHashEvents() {
    if (!window.location.hash) {
      window.location.hash = '#/library';
    }
    window.addEventListener('hashchange', route, false);
  }

  function getAppRoot() {
    var path = window.location.pathname;
    return path.replace(/\/kindle\/?$/, '/');
  }

  function readSetting(key) {
    try {
      return window.localStorage.getItem(STORAGE_PREFIX + key);
    } catch (e) {
      return null;
    }
  }

  function writeSetting(key, value) {
    try {
      if (value === null || typeof value === 'undefined') {
        window.localStorage.removeItem(STORAGE_PREFIX + key);
      } else {
        window.localStorage.setItem(STORAGE_PREFIX + key, value);
      }
    } catch (e) {
      return;
    }
  }

  function clearSession() {
    state.accessToken = null;
    state.refreshToken = null;
    writeSetting('accessToken', null);
    writeSetting('refreshToken', null);
  }

  function escapeHtml(value) {
    if (value === null || typeof value === 'undefined') {
      return '';
    }
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setServerInfo(text) {
    serverNode.innerHTML = escapeHtml(text);
  }

  function setBanner(text, type) {
    if (!text) {
      bannerNode.className = 'banner hidden';
      bannerNode.innerHTML = '';
      state.message = '';
      state.messageType = '';
      return;
    }

    state.message = text;
    state.messageType = type || '';
    bannerNode.className = 'banner ' + (type || '');
    bannerNode.innerHTML = escapeHtml(text);
  }

  function renderShell(bodyHtml, activeRoute) {
    var html = [];
    html.push('<div class="nav">');
    html.push('<a class="nav-link' + (activeRoute === 'library' ? ' active' : '') + '" href="#/library">Library</a>');
    html.push('<a class="nav-link' + (activeRoute === 'browse' ? ' active' : '') + '" href="#/browse">Browse</a>');
    html.push('<a class="nav-link' + (activeRoute === 'history' ? ' active' : '') + '" href="#/history">History</a>');
    html.push('<a class="nav-link' + (activeRoute === 'downloads' ? ' active' : '') + '" href="#/downloads">Downloads</a>');
    if (state.accessToken || state.refreshToken) {
      html.push('<a class="nav-link secondary" href="#/library" onclick="return KindleApp.refreshCurrent();">Refresh</a>');
      html.push('<a class="nav-link secondary" href="#/library" onclick="return KindleApp.logout();">Logout</a>');
    }
    html.push('</div>');
    html.push(bodyHtml);
    appNode.innerHTML = html.join('');
  }

  function renderLoading(message) {
    renderShell('<div class="loading">' + escapeHtml(message || 'Loading...') + '</div>', 'library');
  }

  function loadServerInfo(callback) {
    graphql(aboutServerQuery, {}, { skipAuth: true }, function (err, data) {
      if (err) {
        setServerInfo('Kindle UI ready');
        if (callback) {
          callback();
        }
        return;
      }

      state.server = data.aboutServer;
      setServerInfo(data.aboutServer.name + ' ' + data.aboutServer.version + ' (' + data.aboutServer.buildType + ')');
      if (callback) {
        callback();
      }
    });
  }

  function route() {
    var route = parseRoute();
    state.activeRouteKey = routeKey(route);
    setBanner('', '');

    if (route.name === 'login') {
      renderLogin('');
      return;
    }

    if (route.name === 'downloads') {
      loadDownloadStatus(true);
      return;
    }

    if (route.name === 'browse') {
      loadBrowse();
      return;
    }

    if (route.name === 'history') {
      loadHistory();
      return;
    }

    if (route.name === 'manga') {
      loadManga(route.id);
      return;
    }

    if (route.name === 'reader') {
      loadReader(route.chapterId, route.page);
      return;
    }

    loadLibrary();
  }

  function parseRoute() {
    var raw = window.location.hash || '#/library';
    raw = raw.replace(/^#\/?/, '');
    if (!raw) {
      return { name: 'library' };
    }

    var parts = raw.split('/');
    if (parts[0] === 'login') {
      return { name: 'login' };
    }

    if (parts[0] === 'downloads') {
      return { name: 'downloads' };
    }

    if (parts[0] === 'browse') {
      return { name: 'browse' };
    }

    if (parts[0] === 'history') {
      return { name: 'history' };
    }

    if (parts[0] === 'manga' && parts.length > 1) {
      return { name: 'manga', id: parseInt(parts[1], 10) };
    }

    if (parts[0] === 'reader' && parts.length > 1) {
      return {
        name: 'reader',
        chapterId: parseInt(parts[1], 10),
        page: parts.length > 2 ? parseInt(parts[2], 10) : 0,
      };
    }

    return { name: 'library' };
  }

  function routeKey(route) {
    if (route.name === 'manga') {
      return 'manga:' + route.id;
    }
    if (route.name === 'reader') {
      return 'reader:' + route.chapterId + ':' + route.page;
    }
    return route.name;
  }

  function currentRouteMatches(key) {
    return state.activeRouteKey === key;
  }

  function go(hash) {
    window.location.hash = hash;
  }

  function apiRequest(query, variables, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', GRAPHQL_URL, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (!options.skipAuth && state.accessToken) {
      xhr.setRequestHeader('Authorization', 'Bearer ' + state.accessToken);
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }

      if (xhr.status === 401 && !options.skipAuth) {
        handleUnauthorized(function (refreshErr) {
          if (refreshErr) {
            callback(refreshErr);
            return;
          }
          apiRequest(query, variables, options, callback);
        });
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        callback(new Error('HTTP ' + xhr.status + ' ' + (xhr.responseText || 'request failed')));
        return;
      }

      var payload;
      try {
        payload = JSON.parse(xhr.responseText || '{}');
      } catch (jsonErr) {
        callback(jsonErr);
        return;
      }

      if (payload.errors && payload.errors.length) {
        callback(new Error(payload.errors[0].message || 'GraphQL error'));
        return;
      }

      callback(null, payload.data || payload);
    };

    xhr.send(JSON.stringify({ query: query, variables: variables || {} }));
  }

  function graphql(query, variables, options, callback) {
    apiRequest(query, variables, options || {}, callback);
  }

  function handleUnauthorized(callback) {
    if (!state.refreshToken) {
      clearSession();
      go('#/login');
      renderLogin('Authentication is required.');
      callback(new Error('Unauthorized'));
      return;
    }

    if (state.refreshPending) {
      window.setTimeout(function () {
        handleUnauthorized(callback);
      }, 250);
      return;
    }

    state.refreshPending = true;
    graphql(refreshMutation, { input: { refreshToken: state.refreshToken } }, { skipAuth: true }, function (err, data) {
      state.refreshPending = false;

      if (err || !data || !data.refreshToken || !data.refreshToken.accessToken) {
        clearSession();
        go('#/login');
        renderLogin('Your session expired. Sign in again.');
        callback(err || new Error('Unauthorized'));
        return;
      }

      state.accessToken = data.refreshToken.accessToken;
      writeSetting('accessToken', state.accessToken);
      callback(null);
    });
  }

  function login() {
    var userNode = document.getElementById('kindle-login-user');
    var passNode = document.getElementById('kindle-login-pass');
    var username = userNode ? userNode.value : '';
    var password = passNode ? passNode.value : '';

    setBanner('Signing in...', '');
    graphql(loginMutation, { input: { username: username, password: password } }, { skipAuth: true }, function (err, data) {
      if (err) {
        setBanner(err.message || 'Login failed', 'error');
        renderLogin(err.message || 'Login failed');
        return;
      }

      state.accessToken = data.login.accessToken;
      state.refreshToken = data.login.refreshToken;
      writeSetting('accessToken', state.accessToken);
      writeSetting('refreshToken', state.refreshToken);
      setBanner('Signed in.', 'ok');
      go('#/library');
    });

    return false;
  }

  function logout() {
    clearSession();
    state.library = [];
    state.manga = null;
    state.chapters = [];
    state.downloads = null;
    state.downloadMap = {};
    setBanner('Signed out.', 'ok');
    go('#/login');
    renderLogin('Signed out.');
    return false;
  }

  function renderLogin(message) {
    var body = [];
    body.push('<div class="login-box">');
    body.push('<h2 class="panel-title">Sign in</h2>');
    body.push('<div class="login-hint">The Kindle UI uses the same server session as the main app. If the server does not require login, you can leave this page and use the library directly.</div>');
    if (message) {
      body.push('<div class="banner error">' + escapeHtml(message) + '</div>');
    }
    body.push('<div class="field"><label for="kindle-login-user">Username</label><input id="kindle-login-user" type="text" autocomplete="username"></div>');
    body.push('<div class="field"><label for="kindle-login-pass">Password</label><input id="kindle-login-pass" type="password" autocomplete="current-password"></div>');
    body.push('<div class="login-actions">');
    body.push('<button class="button block" type="button" onclick="return KindleApp.login();">Sign in</button>');
    body.push('</div>');
    body.push('</div>');
    renderShell(body.join(''), 'library');
  }

  function loadLibrary() {
    var routeMarker = state.activeRouteKey;
    renderLoading('Loading library...');
    graphql(libraryQuery, {
      condition: { inLibrary: true },
      orderBy: state.sortBy || 'TITLE',
      orderByType: state.sortDir || 'ASC',
      first: 500,
    }, function (err, data) {
      if (!currentRouteMatches(routeMarker)) {
        return;
      }

      if (err) {
        if (err.message === 'Unauthorized') {
          return;
        }
        setBanner(err.message || 'Failed to load library', 'error');
        renderShell('<div class="empty">' + escapeHtml(err.message || 'Failed to load library') + '</div>', 'library');
        return;
      }

      state.library = data.mangas.nodes || [];
      state.query = state.query || '';
      loadDownloadStatus(false);
      renderLibrary();
    });
  }

  function setSort(by) {
    if (!by) return false;
    // toggle direction if same sort selected
    if (state.sortBy === by) {
      state.sortDir = state.sortDir === 'ASC' ? 'DESC' : 'ASC';
    } else {
      state.sortBy = by;
      state.sortDir = 'ASC';
    }
    // reload library from server with new order
    loadLibrary();
    return false;
  }

  function loadBrowse() {
    var routeMarker = state.activeRouteKey;
    renderLoading('Loading browse...');
    var opdsRoot = APP_ROOT + 'opds/v1.2/';
    fetch(opdsRoot + 'explore', { credentials: 'same-origin' }).then(function (res) {
      return res.text();
    }).then(function (text) {
      if (!currentRouteMatches(routeMarker)) return;
      var parser = new DOMParser();
      var xml = parser.parseFromString(text, 'application/xml');
      var entries = xml.getElementsByTagName('entry');
      var html = [];
      html.push('<div class="panel">');
      html.push('<h2 class="panel-title">Browse</h2>');
      html.push('</div>');
      if (!entries.length) {
        html.push('<div class="empty">No browse entries found.</div>');
        renderShell(html.join(''), 'browse');
        return;
      }
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var titleNode = entry.getElementsByTagName('title')[0];
        var linkNode = entry.getElementsByTagName('link')[0];
        var title = titleNode ? titleNode.textContent : 'Untitled';
        var href = linkNode ? linkNode.getAttribute('href') : '#';
        html.push('<div class="card"><h3 class="card-title"><a href="' + escapeHtml(href) + '" target="_blank">' + escapeHtml(title) + '</a></h3></div>');
      }
      renderShell(html.join(''), 'browse');
    }).catch(function (err) {
      setBanner(err.message || 'Failed to load browse', 'error');
      renderShell('<div class="empty">Failed to load browse</div>', 'browse');
    });
  }

  function loadHistory() {
    var routeMarker = state.activeRouteKey;
    renderLoading('Loading history...');
    var opdsRoot = APP_ROOT + 'opds/v1.2/';
    fetch(opdsRoot + 'history', { credentials: 'same-origin' }).then(function (res) {
      return res.text();
    }).then(function (text) {
      if (!currentRouteMatches(routeMarker)) return;
      var parser = new DOMParser();
      var xml = parser.parseFromString(text, 'application/xml');
      var entries = xml.getElementsByTagName('entry');
      var html = [];
      html.push('<div class="panel">');
      html.push('<h2 class="panel-title">History</h2>');
      html.push('</div>');
      if (!entries.length) {
        html.push('<div class="empty">No history entries found.</div>');
        renderShell(html.join(''), 'history');
        return;
      }
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var titleNode = entry.getElementsByTagName('title')[0];
        var linkNode = entry.getElementsByTagName('link')[0];
        var title = titleNode ? titleNode.textContent : 'Untitled';
        var href = linkNode ? linkNode.getAttribute('href') : '#';
        html.push('<div class="card"><h3 class="card-title"><a href="' + escapeHtml(href) + '" target="_blank">' + escapeHtml(title) + '</a></h3></div>');
      }
      renderShell(html.join(''), 'history');
    }).catch(function (err) {
      setBanner(err.message || 'Failed to load history', 'error');
      renderShell('<div class="empty">Failed to load history</div>', 'history');
    });
  }

  function setQuery() {
    var field = document.getElementById('kindle-library-filter');
    state.query = field ? field.value : '';
    if (parseRoute().name === 'library') {
      renderLibrary();
    }
    return false;
  }

  function renderLibrary() {
    var filtered = [];
    var i;
    var term = (state.query || '').toLowerCase();

    for (i = 0; i < state.library.length; i += 1) {
      var manga = state.library[i];
      if (!term || (manga.title && manga.title.toLowerCase().indexOf(term) !== -1) || (manga.author && manga.author.toLowerCase().indexOf(term) !== -1) || (manga.artist && manga.artist.toLowerCase().indexOf(term) !== -1)) {
        filtered.push(manga);
      }
    }

    var html = [];
    html.push('<div class="panel">');
    html.push('<h2 class="panel-title">Library</h2>');
    html.push('<div class="panel-subtitle">' + filtered.length + ' manga available in the library.</div>');
    html.push('<div class="field"><label for="kindle-library-filter">Search</label><input id="kindle-library-filter" type="text" value="' + escapeHtml(state.query || '') + '" oninput="return KindleApp.setQuery();" placeholder="Filter by title, author, or artist"></div>');
    html.push('<div class="field"><label>Sort</label><div class="sort-controls"><a href="#" onclick="return KindleApp.setSort(\'TITLE\');">Title</a> | <a href="#" onclick="return KindleApp.setSort(\'AUTHOR\');">Author</a></div></div>');
    html.push('<div class="nav">');
    html.push('<a class="nav-link" href="#/downloads">Downloads</a>');
    html.push('<a class="nav-link secondary" href="#/login">Login</a>');
    html.push('</div>');
    html.push('</div>');

    if (!filtered.length) {
      html.push('<div class="empty">No manga matched the current filter.</div>');
    } else {
      for (i = 0; i < filtered.length; i += 1) {
        html.push(renderMangaCard(filtered[i]));
      }
    }

    renderShell(html.join(''), 'library');
  }

  function renderMangaCard(manga) {
    var html = [];
    html.push('<div class="card">');
    if (manga.thumbnailUrl) {
      html.push('<img class="cover" src="' + escapeHtml(authedUrl(manga.thumbnailUrl)) + '" alt="">');
    }
    html.push('<h3 class="card-title"><a href="#/manga/' + manga.id + '">' + escapeHtml(manga.title) + '</a></h3>');
    html.push('<div class="card-meta">Unread: ' + escapeHtml(manga.unreadCount) + ' | Bookmarked: ' + escapeHtml(manga.bookmarkCount) + ' | Downloads: ' + escapeHtml(manga.downloadCount) + '</div>');
    if (manga.author || manga.artist) {
      html.push('<div class="card-meta">' + escapeHtml(manga.author || '') + (manga.author && manga.artist ? ' / ' : '') + escapeHtml(manga.artist || '') + '</div>');
    }
    if (manga.description) {
      html.push('<div class="card-description">' + escapeHtml(manga.description).replace(/\n/g, '<br>') + '</div>');
    }
    html.push('<div class="chapter-actions">');
    html.push('<a class="button secondary" href="#/manga/' + manga.id + '">Open</a>');
    if (manga.firstUnreadChapter && manga.firstUnreadChapter.id) {
      html.push('<a class="button" href="#/reader/' + manga.firstUnreadChapter.id + '/0">Resume</a>');
    }
    html.push('</div>');
    html.push('</div>');
    return html.join('');
  }

  function loadManga(id) {
    var routeMarker = state.activeRouteKey;
    state.manga = null;
    state.chapters = [];
    renderLoading('Loading manga...');

    graphql(mangaQuery, { id: id }, function (err, data) {
      if (!currentRouteMatches(routeMarker)) {
        return;
      }

      if (err) {
        if (err.message === 'Unauthorized') {
          return;
        }
        setBanner(err.message || 'Failed to load manga', 'error');
        renderShell('<div class="empty">' + escapeHtml(err.message || 'Failed to load manga') + '</div>', 'library');
        return;
      }

      state.manga = data.manga;
      state.chapters = data.chapters.nodes || [];
      renderManga();
    });
  }

  function resumeManga() {
    if (!state.manga) {
      return false;
    }

    if (state.manga.firstUnreadChapter && state.manga.firstUnreadChapter.id) {
      go('#/reader/' + state.manga.firstUnreadChapter.id + '/0');
      return false;
    }

    if (state.manga.lastReadChapter && state.manga.lastReadChapter.id) {
      go('#/reader/' + state.manga.lastReadChapter.id + '/0');
      return false;
    }

    if (state.chapters.length) {
      go('#/reader/' + state.chapters[0].id + '/0');
    }

    return false;
  }

  function renderManga() {
    var manga = state.manga;
    if (!manga) {
      return;
    }

    var html = [];
    html.push('<div class="panel">');
    html.push('<a class="nav-link secondary" href="#/library">Back to library</a>');
    html.push('<h2 class="panel-title">' + escapeHtml(manga.title) + '</h2>');
    if (manga.thumbnailUrl) {
      html.push('<img class="cover" src="' + escapeHtml(authedUrl(manga.thumbnailUrl)) + '" alt="">');
    }
    html.push('<div class="panel-subtitle">Unread: ' + escapeHtml(manga.unreadCount) + ' | Bookmarked: ' + escapeHtml(manga.bookmarkCount) + ' | Downloads: ' + escapeHtml(manga.downloadCount) + '</div>');
    if (manga.author || manga.artist) {
      html.push('<div class="meta">' + escapeHtml(manga.author || '') + (manga.author && manga.artist ? ' / ' : '') + escapeHtml(manga.artist || '') + '</div>');
    }
    if (manga.description) {
      html.push('<div class="card-description">' + escapeHtml(manga.description).replace(/\n/g, '<br>') + '</div>');
    }
    html.push('<div class="reader-actions">');
    html.push('<button class="button" type="button" onclick="return KindleApp.resumeManga();">Resume</button>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.refreshCurrent();">Refresh</button>');
    html.push('</div>');
    html.push('</div>');

    if (!state.chapters.length) {
      html.push('<div class="empty">No chapters loaded.</div>');
    } else {
      html.push('<h3 class="panel-title">Chapters</h3>');
      html.push('<ul class="chapter-list">');
      for (var i = 0; i < state.chapters.length; i += 1) {
        html.push(renderChapterItem(state.chapters[i]));
      }
      html.push('</ul>');
    }

    renderShell(html.join(''), 'library');
  }

  function renderChapterItem(chapter) {
    var queued = state.downloadMap[chapter.id];
    var classes = ['chapter-item'];
    if (chapter.isRead) {
      classes.push('read');
    }
    if (chapter.isDownloaded) {
      classes.push('downloaded');
    }

    var html = [];
    html.push('<li class="' + classes.join(' ') + '">');
    html.push('<h4 class="chapter-title"><a href="#/reader/' + chapter.id + '/' + (chapter.lastPageRead || 0) + '">' + escapeHtml(chapter.name) + '</a></h4>');
    html.push('<div class="card-meta">#' + escapeHtml(chapter.chapterNumber) + ' | Pages: ' + escapeHtml(chapter.pageCount) + ' | ' + (chapter.isRead ? 'Read' : 'Unread') + (chapter.isDownloaded ? ' | Downloaded' : '') + (queued ? ' | ' + escapeHtml(queued.state) : '') + '</div>');
    html.push('<div class="chapter-actions">');
    html.push('<a class="button secondary" href="#/reader/' + chapter.id + '/' + (chapter.lastPageRead || 0) + '">Read</a>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.markRead(' + chapter.id + ', ' + chapter.pageCount + ', ' + (chapter.isRead ? 'true' : 'false') + ');">' + (chapter.isRead ? 'Unread' : 'Read') + '</button>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.toggleBookmark(' + chapter.id + ', ' + (chapter.isBookmarked ? 'true' : 'false') + ');">' + (chapter.isBookmarked ? 'Unbookmark' : 'Bookmark') + '</button>');
    html.push('<button class="button" type="button" onclick="return KindleApp.toggleDownload(' + chapter.id + ', ' + (chapter.isDownloaded ? 'true' : 'false') + ');">' + (chapter.isDownloaded || queued ? 'Remove Download' : 'Queue Download') + '</button>');
    html.push('</div>');
    html.push('</li>');
    return html.join('');
  }

  function loadReader(chapterId, page) {
    var routeMarker = state.activeRouteKey;
    renderLoading('Loading chapter...');

    graphql(readerChapterQuery, { id: chapterId }, function (err, data) {
      if (!currentRouteMatches(routeMarker)) {
        return;
      }

      if (err) {
        if (err.message === 'Unauthorized') {
          return;
        }
        setBanner(err.message || 'Failed to load chapter', 'error');
        renderShell('<div class="empty">' + escapeHtml(err.message || 'Failed to load chapter') + '</div>', 'library');
        return;
      }

      hydrateReaderChapter(data.chapter, function (hydrateErr, chapter) {
        if (!currentRouteMatches(routeMarker)) {
          return;
        }

        if (hydrateErr) {
          setBanner(hydrateErr.message || 'Failed to load chapter pages', 'error');
          renderShell('<div class="empty">' + escapeHtml(hydrateErr.message || 'Failed to load chapter pages') + '</div>', 'library');
          return;
        }

        var currentPage = typeof page === 'number' && !isNaN(page) ? page : chapter.lastPageRead || 0;
        if (currentPage < 0 || isNaN(currentPage)) {
          currentPage = chapter.lastPageRead || 0;
        }
        if (chapter.pageCount > 0 && currentPage >= chapter.pageCount) {
          currentPage = chapter.pageCount - 1;
        }

        state.reader = {
          chapter: chapter,
          page: currentPage,
        };
        renderReader();
        saveReaderProgress(chapter.id, currentPage, chapter.pageCount);
      });
    });
  }

  function readerChapterUrl(chapter) {
    var chapterIndex = typeof chapter.sourceOrder === 'number' ? chapter.sourceOrder : chapter.index;
    return APP_ROOT + 'api/v1/manga/' + chapter.mangaId + '/chapter/' + chapterIndex;
  }

  function hydrateReaderChapter(chapter, callback) {
    fetch(authedUrl(readerChapterUrl(chapter)), { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status + ' ' + (res.statusText || 'request failed'));
        }
        return res.json();
      })
      .then(function (hydratedChapter) {
        if (!hydratedChapter) {
          callback(null, chapter);
          return;
        }

        chapter.pageCount = hydratedChapter.pageCount;
        chapter.lastPageRead = hydratedChapter.lastPageRead;
        chapter.lastReadAt = hydratedChapter.lastReadAt;
        chapter.downloaded = hydratedChapter.downloaded;
        chapter.index = hydratedChapter.index;
        chapter.sourceOrder = typeof hydratedChapter.index === 'number' ? hydratedChapter.index : chapter.sourceOrder;
        callback(null, chapter);
      })
      .catch(function (fetchErr) {
        callback(fetchErr);
      });
  }

  // Ensure a helper exists for producing authenticated URLs. Other UI code
  // uses `authedUrl`, but some places call `withToken` (historically used
  // elsewhere). Provide a thin wrapper so image URLs and other resources
  // resolve consistently and avoid runtime errors when `withToken` is missing.
  function withToken(url) {
    return authedUrl(url);
  }

  // Build absolute image URL for a chapter page. Using APP_ROOT ensures the correct base path
  // even when the Kindle UI is served from a sub‑path. This mirrors the URL used by the
  // full WebUI reader.
  function readerImageUrl(chapter, page) {
    // APP_ROOT already ends with '/' (e.g. '/' or '/subpath/')
    var chapterIndex = typeof chapter.sourceOrder === 'number' ? chapter.sourceOrder : chapter.index;
    return withToken(APP_ROOT + 'api/v1/manga/' + chapter.mangaId + '/chapter/' + chapterIndex + '/page/' + page);
  }

  function renderReader() {
    if (!state.reader) {
      return;
    }

    var chapter = state.reader.chapter;
    var page = state.reader.page;
    var total = chapter.pageCount || 0;
    var html = [];
    html.push('<div class="reader">');
    html.push('<div class="reader-header">');
    html.push('<a class="nav-link secondary" href="#/manga/' + chapter.mangaId + '">Back to chapter list</a>');
    html.push('<h2 class="panel-title">' + escapeHtml(chapter.name) + '</h2>');
    html.push('<div class="reader-page-info">Page ' + (page + 1) + ' of ' + (total || '?') + '</div>');
    html.push('</div>');

    if (total > 0) {
      html.push('<img class="reader-image" src="' + escapeHtml(readerImageUrl(chapter, page)) + '" alt="Page ' + (page + 1) + '">');
    } else {
      html.push('<div class="empty">No page count was reported for this chapter.</div>');
    }

    html.push('<div class="reader-actions">');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.prevPage();">Previous</button>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.nextPage();">Next</button>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.markRead(' + chapter.id + ', ' + total + ', ' + (page + 1 >= total ? 'true' : 'false') + ');">Mark read</button>');
    html.push('<button class="button" type="button" onclick="return KindleApp.refreshCurrent();">Refresh</button>');
    html.push('</div>');
    html.push('</div>');

    renderShell(html.join(''), 'library');
  }

  function prevPage() {
    if (!state.reader) {
      return false;
    }
    var page = state.reader.page - 1;
    if (page < 0) {
      page = 0;
    }
    go('#/reader/' + state.reader.chapter.id + '/' + page);
    return false;
  }

  function nextPage() {
    if (!state.reader) {
      return false;
    }
    var page = state.reader.page + 1;
    if (state.reader.chapter.pageCount > 0 && page >= state.reader.chapter.pageCount) {
      page = state.reader.chapter.pageCount - 1;
    }
    go('#/reader/' + state.reader.chapter.id + '/' + page);
    return false;
  }

  function saveReaderProgress(chapterId, page, pageCount) {
    var isRead = pageCount > 0 && (page + 1 >= pageCount);
    graphql(updateChapterMutation, {
      input: {
        id: chapterId,
        patch: {
          lastPageRead: page,
          isRead: isRead,
        },
      },
    }, function (err) {
      if (err) {
        setBanner(err.message || 'Failed to save reading progress', 'error');
      }
    });
  }

  function markRead(chapterId, pageCount, currentRead) {
    var isRead = !currentRead;
    var lastPageRead = isRead && pageCount > 0 ? pageCount - 1 : 0;
    graphql(updateChapterMutation, {
      input: {
        id: chapterId,
        patch: {
          lastPageRead: lastPageRead,
          isRead: isRead,
        },
      },
    }, function (err) {
      if (err) {
        setBanner(err.message || 'Failed to update chapter', 'error');
        return;
      }
      refreshCurrent();
    });
    return false;
  }

  function toggleBookmark(chapterId, currentBookmarked) {
    graphql(updateChapterMutation, {
      input: {
        id: chapterId,
        patch: {
          isBookmarked: !currentBookmarked,
        },
      },
    }, function (err) {
      if (err) {
        setBanner(err.message || 'Failed to update bookmark', 'error');
        return;
      }
      refreshCurrent();
    });
    return false;
  }

  function toggleDownload(chapterId, isDownloaded) {
    var mutation = isDownloaded || state.downloadMap[chapterId] ? dequeueChapterDownloadMutation : enqueueChapterDownloadMutation;
    var fieldName = isDownloaded || state.downloadMap[chapterId] ? 'dequeueChapterDownload' : 'enqueueChapterDownload';
    graphql(mutation, {
      input: { id: chapterId },
    }, function (err) {
      if (err) {
        setBanner(err.message || 'Failed to update downloads', 'error');
        return;
      }
      loadDownloadStatus(true);
    });
    return false;
  }

  function loadDownloadStatus(renderWhenDone) {
    graphql(downloadStatusQuery, {}, function (err, data) {
      if (err) {
        return;
      }

      state.downloads = data.downloadStatus;
      state.downloadMap = {};
      if (state.downloads && state.downloads.queue) {
        for (var i = 0; i < state.downloads.queue.length; i += 1) {
          state.downloadMap[state.downloads.queue[i].chapter.id] = state.downloads.queue[i];
        }
      }

      if (renderWhenDone && parseRoute().name === 'downloads') {
        renderDownloads();
      } else if (parseRoute().name === 'manga') {
        renderManga();
      } else if (parseRoute().name === 'library') {
        renderLibrary();
      }
    });
  }

  function renderDownloads() {
    var downloads = state.downloads;
    var html = [];
    html.push('<div class="panel">');
    html.push('<h2 class="panel-title">Downloads</h2>');
    html.push('<div class="panel-subtitle">Queue state: ' + escapeHtml(downloads ? downloads.state : 'Unknown') + '</div>');
    html.push('<div class="reader-actions">');
    html.push('<button class="button" type="button" onclick="return KindleApp.startDownloader();">Start</button>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.stopDownloader();">Stop</button>');
    html.push('<button class="button danger" type="button" onclick="return KindleApp.clearDownloads();">Clear</button>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.refreshCurrent();">Refresh</button>');
    html.push('</div>');
    html.push('</div>');

    if (!downloads || !downloads.queue || !downloads.queue.length) {
      html.push('<div class="empty">No queued downloads.</div>');
    } else {
      for (var i = 0; i < downloads.queue.length; i += 1) {
        html.push(renderDownloadItem(downloads.queue[i]));
      }
    }

    renderShell(html.join(''), 'downloads');
  }

  function renderDownloadItem(item) {
    var percent = 0;
    if (item.progress && item.progress > 0) {
      percent = Math.min(100, Math.max(0, Math.round(item.progress)));
    }

    var html = [];
    html.push('<div class="download-item">');
    html.push('<h3 class="download-title">' + escapeHtml(item.chapter.manga.title) + ' - ' + escapeHtml(item.chapter.name) + '</h3>');
    html.push('<div class="card-meta">State: ' + escapeHtml(item.state) + ' | Progress: ' + escapeHtml(item.progress) + '% | Tries: ' + escapeHtml(item.tries) + '</div>');
    html.push('<div class="queue-bar"><div class="queue-fill" style="width: ' + percent + '%"></div></div>');
    html.push('<div class="download-actions">');
    html.push('<a class="button secondary" href="#/reader/' + item.chapter.id + '/' + (item.chapter.lastPageRead || 0) + '">Open chapter</a>');
    html.push('<button class="button secondary" type="button" onclick="return KindleApp.toggleDownload(' + item.chapter.id + ', false);">Remove</button>');
    html.push('</div>');
    html.push('</div>');
    return html.join('');
  }

  function startDownloader() {
    graphql(startDownloaderMutation, { input: {} }, function (err) {
      if (err) {
        setBanner(err.message || 'Failed to start downloader', 'error');
        return;
      }
      loadDownloadStatus(true);
    });
    return false;
  }

  function stopDownloader() {
    graphql(stopDownloaderMutation, { input: {} }, function (err) {
      if (err) {
        setBanner(err.message || 'Failed to stop downloader', 'error');
        return;
      }
      loadDownloadStatus(true);
    });
    return false;
  }

  function clearDownloads() {
    graphql(clearDownloaderMutation, { input: {} }, function (err) {
      if (err) {
        setBanner(err.message || 'Failed to clear downloads', 'error');
        return;
      }
      loadDownloadStatus(true);
    });
    return false;
  }

  function refreshCurrent() {
    route();
    return false;
  }

  function authedUrl(url) {
    if (!url) {
      return '';
    }

    if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0 || url.indexOf('data:') === 0) {
      return url;
    }

    if (url.charAt(0) !== '/') {
      url = '/' + url;
    }

    var resolved = APP_ROOT.replace(/\/$/, '') + url;
    if (!state.accessToken) {
      return resolved;
    }

    return resolved + (resolved.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(state.accessToken);
  }
})();
