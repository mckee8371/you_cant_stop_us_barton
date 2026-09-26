# 67 UNBLOCKED GAMES

## Overview

This is an Express/PostgreSQL gaming site with a games library, settings, credits, movies, proxies, updates, browser tab cloaks, a panic-key redirect, accounts, real-time chat, and staff moderation.

## Server-backed hosting

- `index.html` is the site entry point.
- `server.js` runs the Express application, WebSocket chat server, PostgreSQL connection, sessions, uploads, and staff APIs on port 5000.
- Replit preview and deployment run `node server.js`.
- `package.json` contains the server dependencies for Express, PostgreSQL, sessions, uploads, authentication, and WebSockets.
- The database schema is initialized by the server at startup.
- Game pages load `site-features.js` before their external game assets so the panic key and tab cloak still work even when a game uses an external `<base>` URL.

## Site-wide browser features

- `script.js` handles local save-data export/import, game search, settings-page tab cloak controls, and the panic key.
- `site-features.js` applies saved tab cloaks and panic-key redirects on individual game and proxy pages.
- Custom cloak titles and icons, panic settings, low-memory mode, and update dismissal state use `localStorage`.
- `update-popup.js` reads the newest `.update-entry` from `updates.html` and shows it once per update.
- `announcement.js` reads the banner text from the `site_settings` database table through `/api/announcement`.
- `notice.js` reads critical notices from the `site_settings` database table through `/api/notice`.
- `chat.html` displays the chat MOTD and rules from `/api/chat-info`.
- `admin.html` is protected by server-side staff authorization and controls announcements, critical notices, chat MOTD/rules, staff accounts, reports, and room moderation.

## Updating site and chat messages

Staff members can open `admin.html` from the Developer Admin button in Chat. The page can update the site announcement, critical notice, chat MOTD, and chat rules. Changes are stored in PostgreSQL and apply to visitors without editing files.

## Main pages

- `index.html` — home page
- `games.html` — game library
- `proxies.html` — proxy hub
- `settings.html` — browser-only settings
- `credits.html` — credits and play testers
- `movies.html` — movies
- `updates.html` — update history
- `chat.html` — accounts, rooms, real-time chat, direct messages, uploads, and moderation
- `admin.html` — staff-only developer admin panel