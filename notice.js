(function () {
    'use strict';

    fetch('/api/notice')
        .then(function (response) {
            if (!response.ok) throw new Error('Notice unavailable');
            return response.json();
        })
        .then(function (data) {
            var text = data && typeof data.text === 'string' ? data.text.trim() : '';
            if (!text) return;

            var id = data.id && String(data.id).trim();
            if (!id) {
                id = text.toLowerCase().replace(/\s+/g, '-').slice(0, 160);
            }
            if (localStorage.getItem('dismissedNotice') === id) return;
            showNotice(text, id);
        })
        .catch(function () {
            // No notice is shown if the server is unavailable.
        });

    function showNotice(text, id) {
        var style = document.createElement('style');
        style.textContent =
            '@keyframes noticeIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}' +
            '@keyframes noticePulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.4)}50%{box-shadow:0 0 0 8px rgba(239,68,68,0)}}';
        document.head.appendChild(style);

        var overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '10001',
            background: 'rgba(0,0,0,.88)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            boxSizing: 'border-box',
            fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
        });

        var box = document.createElement('div');
        Object.assign(box.style, {
            background: '#0d0505',
            border: '1px solid #7f1d1d',
            borderRadius: '14px',
            padding: '28px',
            width: '460px',
            maxWidth: '92vw',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            animation: 'noticeIn .3s ease,noticePulse 2s ease .3s 2'
        });

        var badge = document.createElement('div');
        badge.textContent = '🚨 IMPORTANT NOTICE';
        Object.assign(badge.style, {
            color: '#ef4444',
            fontSize: '12px',
            fontWeight: '700',
            letterSpacing: '.08em'
        });

        var message = document.createElement('div');
        message.textContent = text;
        Object.assign(message.style, {
            color: '#f1f1f1',
            fontSize: '16px',
            lineHeight: '1.55',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
        });

        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'I Understand';
        Object.assign(button.style, {
            alignSelf: 'flex-end',
            margin: '0',
            padding: '9px 18px',
            borderRadius: '8px',
            cursor: 'pointer',
            background: '#200808',
            border: '1px solid #ef4444',
            color: '#ef4444',
            fontSize: '14px',
            fontWeight: '600'
        });
        button.onclick = function () {
            localStorage.setItem('dismissedNotice', id);
            overlay.remove();
        };

        box.appendChild(badge);
        box.appendChild(message);
        box.appendChild(button);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }
})();