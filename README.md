# DropZone Voice

Cross-device gaming voice rooms built with vanilla JavaScript, WebRTC, and a tiny in-memory Node signaling server.

## Folder Structure

```text
chinacord/
├── README.md
├── package.json
├── server.js
└── public/
    ├── api.js
    ├── app.js
    ├── index.html
    ├── styles.css
    └── webrtc.js
```

## What This Build Does

- Creates rooms on a tiny in-memory signaling server.
- Lets separate devices join the same room.
- Uses WebRTC for peer-to-peer audio.
- Uses Server-Sent Events and REST for signaling and room state.
- Shows connected users and local mute state.
- Includes a closable mic test panel with gain control.

## Run Locally

```bash
cd /Users/fred/chinacord
npm start
```

Then open:

```text
http://localhost:3000
```

To test across devices, open the same host from another device and join with the room code.

## Signaling Notes

- `server.js` is the smallest viable signaling backend.
- Rooms and users live in memory only.
- `api.js` wraps the REST and SSE signaling endpoints.
- WebRTC offers, answers, and ICE candidates are forwarded through the server.
- `webrtc.js` keeps the signaling logic separate from the UI and includes comments for the offer/answer and ICE flow.

## Deployment

This is one deployable project:

- static frontend served from `public/`
- small Node process running `server.js`

For production, deploy to any Node host. If you later want true serverless deployment, the same route shapes can be moved into serverless functions, but the in-memory room store would need shared storage.

### Render

Render can run this app as a single web service.

1. Push this repo to GitHub.
2. In Render, create a new Web Service from the repo.
3. Use these settings:
    - **Runtime**: Node
    - **Build Command**: `npm install`
    - **Start Command**: `npm start`
    - **Health Check Path**: `/`
4. Leave environment variables empty.

The included `render.yaml` blueprint mirrors those settings.

Important: this build now includes a default TURN relay in `server.js`, so cross-network and multi-region calling is supported out of the box.

## TURN Support

Reliable cross-region calling needs TURN, not just STUN. This project includes a default TURN configuration in [server.js](/Users/fred/chinacord/server.js) and exposes it from `/api/config` for the browser to use when creating WebRTC peer connections.

### Self-Hosted Coturn

This repo also includes a minimal Coturn setup:

- [docker-compose.turn.yml](/Users/fred/chinacord/docker-compose.turn.yml)
- [turnserver.conf](/Users/fred/chinacord/turnserver.conf)

Update the public IP / hostname and shared secret or password before using it on the public internet.

If you are deploying to Render, skip the local coturn container.
