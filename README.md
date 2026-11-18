# Real Map Drive

A free, browser-based multiplayer driving game. The 3D world is generated live from OpenStreetMap data: real roads, buildings, water, parks and trees, with street and place name boards. Drive anywhere on Earth, alone or with friends.

No game server, no API keys, no accounts.

## Run it

```
npm install
npm run dev
```

Open the address Vite prints (usually http://localhost:5173).

To run the production build:

```
npm run build
npm run preview      # serves dist/ at http://localhost:4173
```

`dist/` is plain static files. Opening `dist/index.html` straight from disk won't work; serve it over HTTP (`npx serve dist`, or upload it to GitHub Pages, Cloudflare Pages or Netlify).

## Controls

| Key | Action |
| --- | --- |
| W / S, ↑ / ↓ | Accelerate / brake and reverse |
| A / D, ← / → | Steer |
| Space | Handbrake |
| C | Change camera |
| R | Back to the nearest road |

Touch devices get on-screen buttons.

## Features

- **Real 3D world**: roads by class (motorway to footpath) with different widths, lanes and markings; extruded buildings with real footprints and heights, varied facades and roofs; water; woods, parks and street trees.
- **Name boards** for places, streets and points of interest.
- **Go anywhere**: search by place name, enter latitude/longitude, pick a city preset, or use your real location.
- **Real day and night**: the sun position and local clock come from the real time at the place you are driving. Headlamps switch on at night.
- **Multiplayer**: share the invite link and anyone who opens it joins your room. You see each other's cars and name tags and can jump to a player.
- **Lazy loading**: only tiles around you are loaded; far ones are dropped.
- **Built for slow machines**: chunked, frustum-culled geometry, a merged building mesh, instanced trees, and Low / Medium / High / Auto graphics. Auto lowers render resolution, then detail, to hold the frame rate.

## How multiplayer works

Players connect directly to each other with WebRTC through [Trystero](https://github.com/dmotz/trystero), using public Nostr relays only to find each other. There is no game server. Positions are sent as world coordinates at 12 Hz and interpolated on the receiving side. The room is named in the page URL, so sharing the link is all your friend needs. Anyone with the link can join.

Some strict networks (corporate or school Wi-Fi) block WebRTC, and the browser only allows "My location" on `https://` or `localhost`.

## Data and credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, served as vector tiles by [OpenFreeMap](https://openfreemap.org) in the [OpenMapTiles](https://openmaptiles.org) schema.
- Place search by [Nominatim](https://nominatim.org/).
- Built with [three.js](https://threejs.org), [Vite](https://vitejs.dev), `@mapbox/vector-tile`, `pbf`, `earcut`, `tz-lookup` and Trystero.

## Project layout

```
index.html          UI
src/main.js         scene, input, UI wiring, quality presets, main loop
src/world.js        tile streaming, culling, materials, collision queries
src/tileWorker.js   Web Worker: fetches a tile and builds all its geometry
src/car.js          car model and driving physics
src/net.js          peer-to-peer multiplayer
src/sky.js          sun position, time zones, day/night lighting
src/signs.js        name boards
src/shared.js       constants and Mercator helpers
scripts/            headless screenshot, benchmark and multiplayer test helpers
```

## Known limits

- The world is flat: no terrain elevation, and bridges sit at ground level.
- OpenStreetMap has no lane counts, so lanes are typical for each road class.
- Street trees and facade styles are invented, not mapped. Where the map has no buildings along a street, optional guessed houses can fill in.
- Low graphics is visibly softer by design.
