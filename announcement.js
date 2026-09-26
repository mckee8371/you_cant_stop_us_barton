(function () {
    'use strict';

    var DEFAULT = 'NO MOTD YET';
    var bar = document.createElement('div');
    bar.id = 'announcement-bar';
    Object.assign(bar.style, {
        width: '100%',
        boxSizing: 'border-box',
        background: 'linear-gradient(90deg,#0d0d0d 0%,#111 50%,#0d0d0d 100%)',
        borderBottom: '1px solid #222',
        color: '#ddd',
        fontSize: '13px',
        fontWeight: '500',
        textAlign: 'center',
        padding: '8px 20px',
        letterSpacing: '0.02em',
        position: 'relative',
        zIndex: '100',
        fontFamily: 'inherit'
    });

    var textSpan = document.createElement('span');
    textSpan.id = 'announcement-text';
    textSpan.textContent = DEFAULT;
    bar.appendChild(textSpan);
    document.body.insertBefore(bar, document.body.firstChild);

    fetch('/api/announcement')
        .then(function (response) {
            if (!response.ok) throw new Error('Announcement unavailable');
            return response.json();
        })
        .then(function (data) {
            if (data && typeof data.text === 'string' && data.text.trim()) {
                textSpan.textContent = data.text.trim();
            }
        })
        .catch(function () {
            // The default remains visible if the server is unavailable.
        });
})();