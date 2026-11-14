# ProxyWeb 6.0 — TrickyBird-style server proxy

This version replaces the old browser-only proxy approach with a Node.js server that fetches public HTTP(S) pages, rewrites page URLs, maintains short-lived per-session cookie jars, and forwards media bytes and Range requests.

## Deploy

### 1. Deploy the engine to Render
1. Upload this folder to a GitHub repository.
2. In Render, create a **Blueprint** from the repository.
3. Render reads `render.yaml` and deploys the Node service.
4. Copy the service URL, for example `https://proxyweb-engine.onrender.com`.

### 2. Deploy the homepage to Netlify
1. In `netlify-site/config.js`, replace `https://YOUR-RENDER-SERVICE.onrender.com` with your Render URL.
2. Deploy the `netlify-site` folder to Netlify.

The Render service also serves the full ProxyWeb workspace at `/app`, so the browser workspace and proxied pages share one origin. The Netlify homepage's Open button takes the user there.

## Local development
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Important compatibility notes
- This is a TrickyBird-inspired implementation, not TrickyBird's proprietary code.
- A server-side proxy can improve compatibility over a simple iframe, but it cannot make every website work.
- Some games deliberately require their official domain, reject embedding, depend on WebRTC, or use browser features that a web proxy cannot faithfully relay.
- The proxy does not remove site login/paywall/DRM controls or attempt to bypass game site-lock protections.
- Session cookies are held in memory and disappear when the server restarts or the session expires.
- Public proxy deployments can be abused. Keep the service private or add authentication and stronger operational limits before offering it to other people.
