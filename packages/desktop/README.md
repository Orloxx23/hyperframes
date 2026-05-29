# @hyperframes/desktop

HyperFrames Studio empaquetado como app de escritorio con Tauri v2. El CLI corre como sidecar, la webview apunta al `hyperframes preview` HTTP local. Todo offline, sin servicios externos.

---

## Tres comandos para todo

### 1) Desarrollar la app (iterar rápido)

```powershell
# Desde la raíz del repo, una sola vez tras clonar:
bun install
bun run build              # builds del monorepo (core, studio, cli)
bun run desktop:prepare    # compila CLI sidecar + copia Studio bundle

# Cada vez que quieras abrir la app:
bun run desktop:dev
```

`desktop:dev` recompila Rust (primera vez ~3 min, después incrementales en segundos) y abre la ventana. La ventana queda apuntando a `http://127.0.0.1:177XX` donde corre el Studio servido por el sidecar.

**Cuándo correr `desktop:prepare` de nuevo:**

- Cambiaste código del CLI (`packages/cli/`) o del Studio (`packages/studio/`) → sí
- Solo cambiaste código Rust del shell Tauri (`packages/desktop/src-tauri/src/`) → no, `desktop:dev` lo recompila solo
- Cambiaste un script de preparación o tauri.conf.json → no, pero conviene `bun run desktop:prepare` para regenerar artefactos limpios

### 2) Buildear el installer local (probar el paquete completo sin firmar)

```powershell
# Si no lo corriste ya en la sesión (incluye Chrome ~160MB, ffmpeg ~50MB,
# claude CLI ~225MB — la primera vez tarda):
bun run desktop:prepare

# Build del .msi/.nsis:
bun run desktop:build
```

Output:

```
packages/desktop/src-tauri/target/release/bundle/msi/HyperFrames_0.6.51_x64_en-US.msi
packages/desktop/src-tauri/target/release/bundle/nsis/HyperFrames_0.6.51_x64-setup.exe
```

El installer es ~500MB (incluye CLI compilado, Studio, Chromium, ffmpeg, claude CLI del agente). Funciona offline desde la primera instalación. Sin firmar verás warnings de SmartScreen — eso se arregla con el cert en el flujo de release (abajo).

Si solo quieres iterar dev sin el peso de claude CLI/Chromium/ffmpeg, corre `prepare:cli` y `prepare:studio` por separado — el sidecar caerá a system Chrome / PATH ffmpeg / mostrar error en el chat.

### 3) Publicar un release firmado (cuando ya tengas los certs)

```bash
git tag desktop-v0.6.51
git push origin desktop-v0.6.51
```

El workflow [.github/workflows/desktop-release.yml](../../.github/workflows/desktop-release.yml) corre en CI para Windows + macOS (Intel y ARM) + Linux, firma los installers con los secrets del repo, y crea un GitHub Release en draft con `latest.json` para el auto-updater.

Setup de secrets antes del primer release — ver [sección de signing más abajo](#signing).

---

## Cómo funciona el arranque

1. Tauri toma un puerto libre del rango `17777..17877`.
2. Spawnea el sidecar:
   ```
   hyperframes preview <Documents>/HyperFrames --port <port> --no-open
   ```
   con env vars:
   - `HYPERFRAMES_STUDIO_DIR` → `resources/studio/` (bundle del SPA)
   - `HYPERFRAMES_RUNTIME_JS` → `resources/studio/hyperframe-runtime.js`
   - `PRODUCER_HEADLESS_SHELL_PATH` → `resources/chrome/chrome-headless-shell[.exe]`
   - `PATH` (prepended) → `resources/ffmpeg/`
   - `HYPERFRAMES_CLAUDE_CLI_PATH` → `resources/claude/claude[.exe]` (binario que la Agent SDK spawnea para el chat in-Studio)
   - `HYPERFRAMES_TELEMETRY` → `""` (off por default)
3. Hace polling HTTP a `/__hyperframes_config` hasta que el sidecar responde `{ "isHyperframes": true }`.
4. Navega la ventana principal a `http://127.0.0.1:<port>` y la muestra.

El sidecar es el binario `hyperframes-x86_64-pc-windows-msvc.exe` (o el triple de tu plataforma), generado por `bun build --compile`. Cuando cierras la ventana, Tauri mata el sidecar via `RunEvent::ExitRequested` → `SidecarHandle::kill`.

---

## Estructura del paquete

```
packages/desktop/
├── src-tauri/                  # Crate Rust (Tauri v2)
│   ├── src/
│   │   ├── lib.rs              # entry — orquesta el boot
│   │   ├── sidecar.rs          # spawn + supervisión del CLI
│   │   ├── port.rs             # selección de puerto + readiness probe
│   │   └── paths.rs            # resolución de resources bundleados
│   ├── binaries/               # CLI compilado (gitignored — produce prepare:cli)
│   ├── resources/              # Studio + Chromium + ffmpeg (gitignored — produce prepare:*)
│   ├── icons/                  # placeholder branding (reemplazar antes de release)
│   ├── capabilities/default.json   # ACL Tauri v2
│   ├── Cargo.toml
│   └── tauri.conf.json
├── scripts/                    # genera lo que vive en binaries/ y resources/
│   ├── prepare-binaries.ts     # bun --compile del CLI
│   ├── prepare-studio.ts       # copia packages/studio/dist
│   ├── prepare-chromium.ts     # baja chrome-headless-shell
│   ├── prepare-ffmpeg.ts       # baja ffmpeg estático
│   ├── prepare-claude-cli.ts   # copia claude.exe del Agent SDK
│   ├── generate-icon-source.ts # PNG placeholder para `tauri icon`
│   └── _shared.ts              # paths + detección de plataforma
├── frontend-stub/              # HTML que Tauri requiere; se reemplaza por la URL local en boot
├── README.md
└── package.json
```

---

## Por qué algunas cosas están como están

### Por qué `sharp` y `onnxruntime-node` son `--external` en el compile

`bun build --compile` no puede resolver el require dinámico de sharp:

```js
require(`@img/sharp-${process.platform}-${process.arch}/sharp.node`);
```

El `.node` no sobrevive el virtual fs de bun (`B:/~BUN/root/...`). Lo mismo onnxruntime-node. Ambos los marcamos external y nunca se invocan desde el hot-path de `preview` — el desktop nunca llama a `snapshot` ni `remove-background`. Si en el futuro quieres soportar esos comandos en el desktop, hay que shippear `node_modules/sharp` adjacente al binario.

El refactor que hace esto seguro está en [packages/cli/src/capture/contactSheet.ts](../cli/src/capture/contactSheet.ts) — `import sharp` se volvió lazy (`await getSharp()` dentro de la función), así el módulo no se evalúa al hacer `--version` en el binario compilado.

### Por qué los assets del Studio no van embebidos en el binario

El bundle del Studio es HTML/CSS/JS estático servido vía `fs.readFileSync` desde studioServer.ts. Si lo embebiéramos como recurso de `bun --compile`, los paths quedarían en `B:/~BUN/root/...` (el virtual fs) y las llamadas `existsSync` se vuelven impredecibles bajo carga.

Solución: el Studio viaja como Tauri resource en `src-tauri/resources/studio/`, y el sidecar lo encuentra vía la env var `HYPERFRAMES_STUDIO_DIR` que [studioServer.ts:resolveStudioBundle](../cli/src/server/studioServer.ts) ahora consulta primero.

### Por qué ffmpeg se inyecta vía PATH y no env var

El engine spawnea con `spawn("ffmpeg", ...)` literal — no respeta ninguna env var. Antes de spawnear el sidecar, prependemos `resources/ffmpeg/` al PATH heredado por el child. Cero cambios al engine.

### Por qué bundleamos `claude.exe` (225MB) como resource

El chat in-Studio usa `@anthropic-ai/claude-agent-sdk`, que spawnea un binario nativo `claude` distribuido como **optional dep por plataforma** (`@anthropic-ai/claude-agent-sdk-win32-x64`, etc.). En la CLI compilada con `bun --compile`, esas optional deps tienen el mismo problema que sharp/onnxruntime-node — no se resuelven en el virtual fs.

Solución: el script `prepare:claude-cli` copia el binario al `resources/claude/` del bundle Tauri. El sidecar setea `HYPERFRAMES_CLAUDE_CLI_PATH`, y [agentLoop.ts](../cli/src/agent/agentLoop.ts) lo lee y lo pasa como `options.pathToClaudeCodeExecutable` al SDK.

Costo: ~225MB extra en el installer. El SDK expone también un helper `./extract` para entornos bun-compile que extrae a temp dir desde bunfs — podríamos migrar a eso en el futuro para bajar a un solo binario gordo en vez de binario + resource, pero el tamaño total sería el mismo.

### Por qué hardcodeamos un rango de puertos (17777..17877)

Pedir al OS un puerto libre cualquiera es más simple, pero un rango pinned hace:

- Reglas de firewall escopables ("HyperFrames usa estos puertos")
- Tráfico identificable en `netstat`
- Debug más fácil cuando hay varios installs corriendo

---

## Signing

### Updater (requerido para auto-update)

```bash
# Genera una vez. GUARDA el .key en 1Password/Vault — si lo pierdes,
# nadie con la versión instalada puede recibir updates jamás.
bunx tauri signer generate -w ~/.tauri/hyperframes-desktop.key

# Copia la public key en packages/desktop/src-tauri/tauri.conf.json:
#   plugins.updater.pubkey = "..."

# Secrets del repo:
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/hyperframes-desktop.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body "<passphrase>"
```

### Windows Authenticode (.pfx)

Cert de una CA reconocida (DigiCert, Sectigo, SSL.com). Los EV resetean la reputación de SmartScreen al toque; los standard requieren warmup de unas semanas.

```bash
base64 -w 0 hyperframes.pfx | gh secret set WINDOWS_CERTIFICATE
gh secret set WINDOWS_CERTIFICATE_PASSWORD --body "<pfx-password>"
```

### macOS code signing + notarization

Requiere Apple Developer Program (USD 99/año).

1. Genera un cert "Developer ID Application" en developer.apple.com → exporta como .p12.
2. Crea un app-specific password en appleid.apple.com.
3. Apuntate tu Team ID (esquina sup. der. del portal).

```bash
base64 -w 0 developer-id.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD --body "<p12-password>"
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: HyperFrames (TEAMID)"
gh secret set APPLE_ID --body "you@example.com"
gh secret set APPLE_PASSWORD --body "<app-specific-password>"
gh secret set APPLE_TEAM_ID --body "TEAMID"
```

---

## Reemplazar los icons placeholder

`src-tauri/icons/source.png` es un gradiente radial generado proceduralmente. Para release necesitas algo real:

```powershell
# Reemplaza src-tauri/icons/source.png con un PNG 1024x1024 transparente,
# luego:
cd packages/desktop
bun x tauri icon src-tauri/icons/source.png
```

`tauri icon` regenera todos los variants (32x32, 128x128, .ico Windows, .icns macOS, iOS, Android, tiles de Windows Store). Commitea lo regenerado.

---

## Problemas comunes

| Síntoma                                                                         | Causa                                                       | Fix                                                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Waiting for your frontend dev server to start on http://localhost:1420/`       | `devUrl` en tauri.conf.json                                 | Ya no está. Si lo ves, hay config stale — verifica `tauri.conf.json`.                                                |
| `resource path 'binaries\hyperframes-x86_64-pc-windows-msvc.exe' doesn't exist` | Sidecar no compilado para tu triple                         | `bun run --filter @hyperframes/desktop prepare:cli`                                                                  |
| `Studio build missing` en log del sidecar                                       | `HYPERFRAMES_STUDIO_DIR` apunta a nada                      | `bun run --filter @hyperframes/desktop prepare:studio`                                                               |
| Ventana abre, sidecar muere al lanzar Chrome                                    | `PRODUCER_HEADLESS_SHELL_PATH` apunta a binario inexistente | `bun run --filter @hyperframes/desktop prepare:chromium`, o limpia el path para que el CLI haga su propia resolución |
| Chat dice `Native CLI binary for win32-x64 not found`                           | No corriste `prepare:claude-cli`                            | `bun run --filter @hyperframes/desktop prepare:claude-cli` (ya está incluido en `prepare:all`)                       |
| Sidecar sobrevive al cerrar la ventana                                          | Handler `ExitRequested` no se disparó                       | Bug; debería ser imposible. Ver [lib.rs](src-tauri/src/lib.rs) `RunEvent` match.                                     |
| Cargo se queda colgado en `tauri-runtime-wry`                                   | Primera build, normal                                       | Tomar agua. Builds siguientes son incrementales.                                                                     |

---

## Pendiente antes del release público

- [ ] Reemplazar icons placeholder con branding real
- [ ] Generar + commitear updater public key en `tauri.conf.json`
- [ ] Conseguir cert Authenticode + Apple Developer ID
- [ ] Setear los secrets de GitHub Actions
- [ ] Decidir endpoint del updater (default: GitHub Releases del repo público; cambia `plugins.updater.endpoints` si vas a self-host)
- [ ] Menú nativo (File → New project, Window → switcher de workspace)
- [ ] UX de auto-update: el plugin está instalado pero el botón "buscar updates" no existe en la UI del Studio todavía — pequeño componente React que llame a `@tauri-apps/plugin-updater`
