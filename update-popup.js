(function () {
    var scriptUrl = document.currentScript && document.currentScript.src;
    var updatesUrl = scriptUrl ? new URL('updates.html', scriptUrl).href : 'updates.html';

    fetch(updatesUrl)
        .then(function (r) { return r.text(); })
        .then(function (html) {
            var parser = new DOMParser();
            var doc = parser.parseFromString(html, 'text/html');
            var entry = doc.querySelector('.update-entry');
            if (!entry) return;

            var date  = (entry.querySelector('.update-date')  || {}).textContent || '';
            var title = (entry.querySelector('.update-title') || {}).textContent || '';
            var items = Array.from(entry.querySelectorAll('.update-items li')).map(function (li) {
                return li.textContent.trim();
            });

            var id = (date.trim() + '|' + title.trim()).toLowerCase().replace(/\s+/g, '-');
            if (localStorage.getItem('lastSeenUpdate') === id) return;

            showPopup({ id: id, date: date.trim(), title: title.trim(), items: items });
        })
        .catch(function () {});

    function showPopup(update) {
        var overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '10000',
            background: 'rgba(0,0,0,0.85)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            padding: '20px', boxSizing: 'border-box'
        });

        var box = document.createElement('div');
        Object.assign(box.style, {
            background: '#0a0a0a', border: '1px solid #2a2a2a',
            borderRadius: '16px', padding: '32px', maxWidth: '480px',
            width: '100%', boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
            display: 'flex', flexDirection: 'column', gap: '16px',
            animation: 'upopFadeIn 0.25s ease'
        });

        var style = document.createElement('style');
        style.textContent = '@keyframes upopFadeIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}';
        document.head.appendChild(style);

        var badge = document.createElement('div');
        Object.assign(badge.style, {
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            background: '#111', border: '1px solid #222', borderRadius: '20px',
            padding: '4px 12px', width: 'fit-content'
        });
        badge.innerHTML = '<span style="width:8px;height:8px;background:#4ade80;border-radius:50%;display:inline-block;"></span>'
            + '<span style="font-size:12px;color:#4ade80;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">New Update</span>';

        var dateEl = document.createElement('div');
        Object.assign(dateEl.style, { fontSize: '12px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.1em' });
        dateEl.textContent = update.date;

        var titleEl = document.createElement('div');
        Object.assign(titleEl.style, { fontSize: '20px', fontWeight: '700', color: '#fff', lineHeight: '1.3' });
        titleEl.textContent = update.title;

        var ul = document.createElement('ul');
        Object.assign(ul.style, { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: '8px' });
        update.items.forEach(function (item) {
            var li = document.createElement('li');
            Object.assign(li.style, { display: 'flex', gap: '10px', fontSize: '14px', color: '#aaa', alignItems: 'flex-start' });
            li.innerHTML = '<span style="color:#fff;font-weight:700;flex-shrink:0;margin-top:1px;">+</span><span>' + item + '</span>';
            ul.appendChild(li);
        });

        var btnRow = document.createElement('div');
        Object.assign(btnRow.style, { display: 'flex', gap: '10px', marginTop: '4px', flexWrap: 'wrap' });

        function makeBtn(label, bg, border, color) {
            var b = document.createElement('button');
            b.textContent = label;
            Object.assign(b.style, {
                flex: '1', padding: '11px 20px', borderRadius: '8px', border: '1px solid ' + border,
                background: bg, color: color, cursor: 'pointer', fontSize: '14px',
                fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em',
                transition: 'all 0.15s ease', outline: 'none'
            });
            return b;
        }

        var gotItBtn = makeBtn('Got it', '#fff', '#fff', '#000');
        var allBtn   = makeBtn('All Updates', '#111', '#333', '#fff');

        gotItBtn.onmouseenter = function () { gotItBtn.style.background = '#ddd'; };
        gotItBtn.onmouseleave = function () { gotItBtn.style.background = '#fff'; };
        allBtn.onmouseenter   = function () { allBtn.style.background = '#fff'; allBtn.style.color = '#000'; };
        allBtn.onmouseleave   = function () { allBtn.style.background = '#111'; allBtn.style.color = '#fff'; };

        function dismiss() {
            localStorage.setItem('lastSeenUpdate', update.id);
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.2s ease';
            setTimeout(function () { overlay.remove(); }, 200);
        }

        gotItBtn.onclick = dismiss;
        allBtn.onclick = function () { dismiss(); window.location.href = 'updates.html'; };
        overlay.addEventListener('click', function (e) { if (e.target === overlay) dismiss(); });

        btnRow.appendChild(gotItBtn);
        btnRow.appendChild(allBtn);
        box.appendChild(badge);
        box.appendChild(dateEl);
        box.appendChild(titleEl);
        if (update.items.length) box.appendChild(ul);
        box.appendChild(btnRow);
        overlay.appendChild(box);

        function show() { document.body.appendChild(overlay); }
        if (document.body) { show(); } else { document.addEventListener('DOMContentLoaded', show); }
    }
})();
