// Hawkes Net's shared page script (served at /site.js): the header every page shares (Home, Docs, Quickstart, Demo) and
// the Copy button on every code block, including blocks a page draws later. It makes no requests and runs no timers:
// the header is made once, blocks are found by an observer, and "Copied" ends on the CSS animation's own event.
(() => {
  const dashHost = /^net(-beta)?\.hawkesgames\.com$/i.test(location.hostname); // there "/" is the dashboard, so Home is /home
  const links = [['home', dashHost ? '/home' : '/', 'Home'], ['docs', '/docs/errors', 'Docs'], ['quickstart', '/quickstart', 'Quickstart'], ['demo', '/demo', 'Demo']];
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const here = p === '/' || p === '/home' ? 'home' : p.startsWith('/docs') ? 'docs' : p === '/quickstart' ? 'quickstart' : p === '/demo' ? 'demo' : '';
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = '<div class="in"><a class="brand" href="' + links[0][1] + '">Hawkes Net</a><button class="menu" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button><nav id="site-nav" aria-label="Hawkes Net">'
    + links.map(([k, href, label]) => '<a href="' + href + '"' + (k === here ? ' aria-current="page"' : '') + '>' + label + '</a>').join('')
    + '<a href="/dashboard"' + (p === '/dashboard' || (dashHost && p === '/') ? ' aria-current="page"' : '') + '>Dashboard</a></nav></div>';
  document.body.prepend(header);
  // At phone size the nav is folded (site.css); the Menu button opens and closes it. Escape or a tap on a link closes it too.
  const menu = header.querySelector('.menu'), nav = header.querySelector('nav');
  const setMenu = (open) => { nav.classList.toggle('open', open); menu.setAttribute('aria-expanded', String(open)); };
  menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  function copyText(text) {
    const old = () => new Promise((resolve, reject) => { // the old way, from a selected textarea (plain http, or a refused permission)
      const t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;opacity:0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy refused')); } catch (e) { reject(e); } finally { t.remove(); }
    });
    return navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text).catch(old) : old();
  }
  function decorate(pre) {
    if (pre.parentElement?.classList.contains('codeblock')) return;
    const box = document.createElement('div');
    box.className = 'codeblock';
    pre.replaceWith(box);
    box.appendChild(pre);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'copy'; b.setAttribute('aria-label', 'Copy this code');
    b.innerHTML = '<span class="idle">Copy</span><span class="done">Copied</span>';
    b.addEventListener('click', () => {
      copyText(pre.innerText.replace(/\n$/, '')).then(() => { b.classList.add('copied'); b.dataset.copied = String((Number(b.dataset.copied) || 0) + 1); b.setAttribute('aria-label', 'Copied'); },
        () => { b.querySelector('.idle').textContent = 'Press Ctrl+C'; getSelection().selectAllChildren(pre); });
    });
    b.addEventListener('animationend', () => { b.classList.remove('copied'); b.setAttribute('aria-label', 'Copy this code'); });
    box.appendChild(b);
  }
  const all = (root) => { if (root.matches?.('pre')) decorate(root); root.querySelectorAll?.('pre').forEach(decorate); };
  all(document);
  new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach((n) => { if (n.nodeType === 1) all(n); }); }).observe(document.body, { childList: true, subtree: true });
  document.documentElement.dataset.siteReady = '1';
})();
