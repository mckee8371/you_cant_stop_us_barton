(function () {
    'use strict';

    var statusEl = document.getElementById('status');
    var settingKeys = ['announcement', 'notice', 'chat_motd', 'chat_rules'];

    function setStatus(message, error) {
        statusEl.textContent = message || '';
        statusEl.className = 'status' + (error ? ' error' : '');
    }

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
        });
    }

    async function request(url, options) {
        var response = await fetch(url, options);
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || 'Request failed.');
        return data;
    }

    function setValue(id, value) {
        var field = document.getElementById(id);
        if (field) field.value = value || '';
    }

    async function loadSettings() {
        var data = await request('/api/admin/settings');
        settingKeys.forEach(function (key) {
            setValue(key, data.settings[key] && data.settings[key].value);
        });
    }

    async function saveSetting(key) {
        try {
            await request('/api/admin/settings/' + encodeURIComponent(key), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: document.getElementById(key).value })
            });
            setStatus('Saved ' + key.replace('_', ' ') + '.');
        } catch (error) {
            setStatus(error.message, true);
        }
    }

    async function saveNotice() {
        try {
            await request('/api/admin/notice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: document.getElementById('notice').value })
            });
            setStatus('Critical notice saved.');
        } catch (error) {
            setStatus(error.message, true);
        }
    }

    async function loadStaff() {
        var staff = await request('/api/staff');
        var target = document.getElementById('staffList');
        if (!staff.length) {
            target.innerHTML = '<div class="empty">No staff accounts found.</div>';
            return;
        }
        target.innerHTML = staff.map(function (username) {
            var canRemove = username.toLowerCase() !== 'loafyen';
            return '<div class="list-item"><span>⚡ ' + esc(username) + '</span>' +
                (canRemove ? '<button class="danger" onclick="removeStaff(' + JSON.stringify(username) + ')">Remove</button>' : '<span class="muted">Owner</span>') +
                '</div>';
        }).join('');
    }

    async function assignStaff() {
        var input = document.getElementById('staffUsername');
        var username = input.value.trim();
        if (!username) return setStatus('Enter a username first.', true);
        try {
            await request('/api/staff/assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username })
            });
            input.value = '';
            await loadStaff();
            setStatus(username + ' is now staff.');
        } catch (error) {
            setStatus(error.message, true);
        }
    }

    async function removeStaff(username) {
        if (!confirm('Remove ' + username + ' from staff?')) return;
        try {
            await request('/api/staff/unassign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username })
            });
            await loadStaff();
            setStatus(username + ' is no longer staff.');
        } catch (error) {
            setStatus(error.message, true);
        }
    }

    function renderTable(targetId, headers, rows, emptyMessage) {
        var target = document.getElementById(targetId);
        if (!rows.length) {
            target.innerHTML = '<div class="empty">' + emptyMessage + '</div>';
            return;
        }
        target.innerHTML = '<table><thead><tr>' + headers.map(function (header) {
            return '<th>' + header + '</th>';
        }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }

    async function loadReports() {
        var roomReports = await request('/api/reports');
        renderTable('roomReports', ['Room', 'Reporter', 'Reason', 'Status', 'Action'], roomReports.map(function (report) {
            return '<tr><td>' + esc(report.room_code) + '</td><td>' + esc(report.reporter_username) +
                '</td><td>' + esc(report.reason) + '</td><td>' + (report.resolved ? 'Resolved' : 'Open') +
                '</td><td>' + (report.resolved ? '' : '<button onclick="resolveRoomReport(' + report.id + ')">Resolve</button>') + '</td></tr>';
        }), 'No room reports.');

        var userReports = await request('/api/user-reports');
        renderTable('userReports', ['User', 'Reporter', 'Reason', 'Status', 'Action'], userReports.map(function (report) {
            return '<tr><td>' + esc(report.reported_username) + '</td><td>' + esc(report.reporter_username) +
                '</td><td>' + esc(report.reason) + '</td><td>' + (report.resolved ? 'Resolved' : 'Open') +
                '</td><td>' + (report.resolved ? '' : '<button onclick="resolveUserReport(' + report.id + ')">Resolve</button>') + '</td></tr>';
        }), 'No user reports.');
    }

    async function loadRooms() {
        var rooms = await request('/api/staff/rooms');
        renderTable('allRooms', ['Room', 'Owner', 'Messages', 'Online', 'Action'], rooms.map(function (room) {
            return '<tr><td>' + esc(room.room_code) + '</td><td>' + esc(room.owner) +
                '</td><td>' + room.message_count + '</td><td>' + room.online_count +
                '</td><td><button class="danger" onclick="deleteRoom(' + JSON.stringify(room.room_code) + ')">Delete</button></td></tr>';
        }), 'No rooms found.');
    }

    async function resolveRoomReport(id) {
        await request('/api/reports/' + id + '/resolve', { method: 'POST' });
        await loadReports();
        setStatus('Room report resolved.');
    }

    async function resolveUserReport(id) {
        await request('/api/user-reports/' + id + '/resolve', { method: 'POST' });
        await loadReports();
        setStatus('User report resolved.');
    }

    async function deleteRoom(code) {
        if (!confirm('Delete room ' + code + ' and its messages?')) return;
        await request('/api/room/' + encodeURIComponent(code), { method: 'DELETE' });
        await loadRooms();
        setStatus('Room deleted.');
    }

    async function loadAll() {
        try {
            await Promise.all([loadSettings(), loadStaff(), loadReports(), loadRooms()]);
            setStatus('Admin data refreshed.');
        } catch (error) {
            if (error.message === 'Not logged in.' || error.message === 'Staff only.') {
                location.href = 'chat.html';
                return;
            }
            setStatus(error.message, true);
        }
    }

    async function logout() {
        await fetch('/api/logout', { method: 'POST' });
        location.href = 'chat.html';
    }

    window.saveSetting = saveSetting;
    window.saveNotice = saveNotice;
    window.assignStaff = assignStaff;
    window.removeStaff = removeStaff;
    window.resolveRoomReport = resolveRoomReport;
    window.resolveUserReport = resolveUserReport;
    window.deleteRoom = deleteRoom;
    window.loadAll = loadAll;
    window.logout = logout;
    loadAll();
})();