(function () {
    'use strict';

    var CLOAK_PRESETS = {
        schoology: {
            title: 'Home | Schoology',
            icon: 'https://asset-cdn.schoology.com/sites/all/themes/schoology_theme/favicon.ico'
        },
        iready: {
            title: 'i-Ready',
            icon: 'https://www.curriculumassociates.com/favicon.ico'
        },
        ixl: {
            title: 'IXL | Math, Language Arts, Science, Social Studies, and Spanish',
            icon: 'https://www.ixl.com/favicon.ico'
        },
        clever: {
            title: 'Clever | Log in',
            icon: 'https://www.google.com/s2/favicons?domain=clever.com&sz=64'
        }
    };

    function getFavicon() {
        var link = document.querySelector("link[rel~='icon']");
        return link ? link.href : '';
    }

    function setFavicon(url) {
        var link = document.querySelector("link[rel~='icon']");
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            (document.head || document.body).appendChild(link);
        }
        link.href = url;
    }

    function applyCloak() {
        var type = localStorage.getItem('cloakType');
        var title = '';
        var icon = '';

        if (type === 'custom') {
            title = localStorage.getItem('customCloakTitle') || '';
            icon = localStorage.getItem('customCloakIcon') || '';
        } else if (type && CLOAK_PRESETS[type]) {
            title = CLOAK_PRESETS[type].title;
            icon = CLOAK_PRESETS[type].icon;
        }

        if (title) document.title = title;
        if (icon) setFavicon(icon);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyCloak);
    } else {
        applyCloak();
    }
    window.addEventListener('load', applyCloak);

    document.addEventListener('keydown', function (event) {
        var panicKey = localStorage.getItem('panicKey');
        var panicUrl = localStorage.getItem('panicUrl');
        if (!panicKey || !panicUrl) return;

        var active = document.activeElement;
        var tag = active ? active.tagName : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable)) return;

        if (event.key === panicKey) {
            event.preventDefault();
            window.location.href = panicUrl;
        }
    });
})();