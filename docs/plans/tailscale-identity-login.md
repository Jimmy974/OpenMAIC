# Plan: Signed identity login, family roles and course sharing

Review target: `docs/plans/tailscale-identity-login.md` (this file, report file for /plan-eng-review)
Branch: `feat/tailscale-identity` on `Jimmy974/OpenMAIC`
Approved design: `docs/designs/tailscale-identity-login.md` (Status: APPROVED, answer D14, 2026-09-26)

## Working plan

The working plan is the approved design (Approach B: a host bridge verifies that
the caller is `tailscaled`, turns Tailscale identity headers into a signed,
provider-neutral identity; the app verifies the signature in route and
server-action code). Sections referenced below as "Design §N" are in the
approved design. Amendments accepted during this review are listed under
"Accepted amendments" and take precedence over the design where they differ.

### Accepted amendments

- **R2-4 (factual correction):** `GET /api/stages/[id]/manifest` and
  `/freshness` read through `readFreshnessManifest`, which runs through the
  owner-bound store's `readGated`. They are therefore covered by the same
  `canReadStage` gate as `GET /api/stages/[id]` and `/scenes` (owner, admin and
  share recipients get live refresh; everyone else 404). Both routes join the
  student's 404 success check.
- **R2-8 (procedure, required proof of Design §7):** cut-over sequence:
  1. `docker compose stop openmaic` (runner idle).
  2. `pg_dump` to `~/backups/openmaic-<ts>.sql`.
  3. Run `scripts/reassign-owner.sql` with the owner mapping.
  4. Build and deploy the auth-mode image; start the bridge user service.
  5. Switch `tailscale serve` from `:3000` to `:3001`.
  6. Start the app; run the post-checks (every moved course opens for its new
     owner, forged-header probes fail, parent sees library).
  7. On a failed check: switch Serve back to `:3000`, restore the dump, run the
     previous image.
- **R2-9 (documentation, matches evidence):** v1 documents tailnet invites as
  the supported way to add a member. Node sharing is listed as "expected to
  work per Tailscale docs, not yet verified"; the ops checklist includes a live
  header check for the first node-shared member.
  *Verified 2026-09-27:* a node-shared member's requests arrived with
  `Tailscale-User-Login`, were signed by the bridge and registered as a
  non-admin member; a course shared with them opened and the other courses
  answered 404. Node sharing is now the documented default for family members.
- **R2-10 (clarity, required proof of Design §2 and §4):** `GET
  /api/stages/[id]/status`, the three file-classroom routes and every new
  `/api/auth/*`, `/api/admin/*`, `/api/shares/*` and `/api/stages/[id]/shares`
  route resolve identity through one helper, `ownerIdOr401(req)`: missing,
  forged or stale identity → `401 AUTH_REQUIRED`; failed access check → `404`.
  These routes are included in the forged-header test.

## Scope record (Scope Challenge B)

feature answers: none proposed (full scope already chosen, D6 "C) 全部"); structure: A "Original arrangement" (D15); accepted scope: every feature in the approved design, one route file per endpoint, logic in `lib/server/auth/{signed-identity,members,shares,access,quiz-results}.ts`; pending remedies: R2-1, R2-2, R2-3, R2-5/6, R2-7, R2-11.

## Decision ledger

### R2-1: Host-network containers and the bridge's root-peer check
Finding: 1, P1, confidence 8/10, Design §8 ("peer check: TCP peer socket uid must be 0"), reviewer: spec review round 2
Plan baseline: Design §8 as approved (D14): accept only peers whose socket uid is 0; Premise 3 says other containers cannot forge identity.
Runtime evidence: debian 2026-09-26: `tailscaled` runs as root; `docker inspect` shows no container with `NetworkMode=host` (openmaic_default, openmaic_render, 02_assistant_default, cgt-app_dev-network). Probe: clawdbot peer uid 1001, sudo peer uid 0, Serve peer uid 0.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| Host-network guard | none (unspecified) | bridge refuses to start and logs when a running container uses host networking, unless listed in `BRIDGE_TRUSTED_HOST_NET`; re-checked every 10 minutes (serves 503 while violated) | none; ops note only |
| Boundary tests | unspecified | `/proc/net/tcp` parser unit tests with fixtures on the Mac; live probes on debian (non-root → 403; Serve → allowed) | same tests as A |
| Premise 3 wording | "other containers cannot forge" | unchanged, enforced by the guard | narrowed: "no host-network containers exist today" |
Question D16:
D16 — 點樣處理「用 host 網絡嘅容器可以扮 root」？
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity；Design §8 橋接只接受 uid 0（tailscaled）嘅連線。
ELI10: 橋接靠「連入嚟嘅程式係咪 root」嚟確認係 tailscaled。如果將來有人開一個用 host 網絡、以 root 身份行嘅容器，佢都會係 uid 0，就可以扮你。而家部機一個都冇（已查證）。A 會自動檢查：一發現有呢類容器，橋接就拒絕服務並記錄；B 只係喺文件寫低「唔好開呢類容器」。
Stakes if we pick wrong: 揀 B 而將來有人開咗 host 網絡容器，佢就可以冒充家長睇晒所有課同成績，而你唔會知。
Recommendation: A 因為檢查只係每 10 分鐘行一次 docker inspect，成本極低，而且將保安前提由「靠記性」變成「自動執行」。
Completeness: A=10/10, B=6/10
Net: 用好少額外 code，換保安前提自動保證。
Header: Host net guard
Options:
A) Auto guard (recommended)
✅ 橋接啟動時同每 10 分鐘用 docker inspect 檢查，發現用 host 網絡嘅容器就拒絕服務（503）並記錄，可以用 BRIDGE_TRUSTED_HOST_NET 明確列出信任嘅容器。✅ /proc/net/tcp 解析喺 Mac 用測試資料測，debian 上再做真實探測（human: ~1 日 / CC: ~20 分鐘）。❌ 橋接要有權限行 docker 指令（clawdbot 已經喺 docker 群組），將來真係要用 host 網絡容器就要設定例外。
B) Document only
✅ 最簡單，喺文件寫明「唔好開 host 網絡容器」，Mac 同 debian 上一樣做邊界測試。✅ 而家部機冇呢類容器，短期冇風險（human: ~1 小時 / CC: ~5 分鐘）。❌ 將來有人（包括 AI agent）開咗呢類容器，冒充漏洞會靜靜出現，冇任何警告。

State: approved
Actual answer: A) Auto guard (D16, 2026-09-26)
Accepted scope: Bridge checks `docker inspect` of running containers at start and every 10 minutes; any container with host networking not listed in `BRIDGE_TRUSTED_HOST_NET` makes the bridge refuse service (503) and log the container name; `/proc/net/tcp{,6}` parser unit tests with fixtures on the Mac; live probes on debian (non-root peer → 403, Serve peer → allowed); Premise 3 wording unchanged.
History: none

### R2-2: Who can read the signing secret
Finding: 2, P1, confidence 9/10, Design §1/§8 (secret in bridge env and app env; Premise 3), reviewer: spec review round 2
Plan baseline: Design §1 as approved (D14) leaves the secret's storage and readers unspecified; Premise 3 says non-root host processes cannot forge.
Runtime evidence: debian: `clawdbot` owns `~/source/OpenMAIC/.env.local` (mode 600), runs the `grok-relay` user service, and is in the `docker` group (can run `docker inspect` on the app container, which is root-equivalent on the host).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| Trusted parties | unspecified | root, `clawdbot` (bridge service user, owner of the deployment) and `docker` group members | root, a new `openmaic-bridge` system user, `docker` group members |
| Secret storage | unspecified | `~/source/identity-bridge/.env` (0600, clawdbot) and `~/source/OpenMAIC/.env.local` (0600, clawdbot) | root-owned credential via systemd `LoadCredential=`, compose env file root-only (0600) |
| Premise 3 / criterion wording | "non-root host processes cannot forge" | "processes of users other than root, clawdbot and docker-group members cannot forge" | unchanged wording, but clawdbot stays in docker group and can still read the app container env |
Question D17:
D17 — 簽名密鑰放邊度、信任邊個帳戶？
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity；密鑰令 app 相信身份係真嘅。
ELI10: 橋接同 app 都要知道同一個密鑰。邊個讀到密鑰，邊個就可以簽出任何人嘅身份。問題係 clawdbot 帳戶本身已經喺 docker 群組，可以直接睇 app 容器嘅設定，等於 root 權限。所以就算整一個專用帳戶去放密鑰（B），clawdbot 都讀得到。A 係老實咁承認：部機嘅管理員帳戶（root、clawdbot、docker 群組）本來就控制晒一切，所以信任佢哋。
Stakes if we pick wrong: 揀 B 會多一個帳戶同 systemd 設定要維護，但實際上擋唔到 clawdbot，只係製造安全錯覺。
Recommendation: A 因為 docker 群組本身等同 root，B 嘅額外複雜度換唔到真正保護。
Completeness: A=9/10, B=7/10
Net: 老實咁信任部機管理員，定多做複雜設定但擋唔到佢。
Header: Secret trust
Options:
A) Trust box admins (recommended)
✅ 密鑰放喺兩個只有 clawdbot 讀到嘅檔案（0600），文件寫明信任 root、clawdbot 同 docker 群組，前提 3 同成功標準照實修改。✅ 最簡單亦最誠實，同現有 grok-relay 做法一致（human: ~2 小時 / CC: ~5 分鐘）。❌ 如果 clawdbot 帳戶被入侵，入侵者可以冒充任何人（但佢同時已經可以控制 docker 同成部機）。
B) Dedicated bridge user
✅ 新增 openmaic-bridge 系統帳戶，密鑰用 systemd LoadCredential 由 root 提供，compose 設定只有 root 讀到。✅ 其他普通帳戶完全讀唔到密鑰（human: ~1 日 / CC: ~30 分鐘）。❌ clawdbot 仍然喺 docker 群組，照樣可以 docker inspect 讀到 app 容器嘅密鑰，實際保護有限，仲要多維護一個帳戶。

State: approved
Actual answer: A) Trust box admins (D17, 2026-09-26)
Accepted scope: Secret stored only in `~/source/identity-bridge/.env` (0600, clawdbot) and `~/source/OpenMAIC/.env.local` (0600, clawdbot); ops doc names root, clawdbot and docker-group members as trusted; Premise 3 and the forged-header success criterion reworded to "processes of users other than root, clawdbot and docker-group members cannot forge an identity".
History: none

### R2-3: External skill API clients in auth mode
Finding: 3, P2, confidence 8/10, Design §4 table row "file-based classrooms … admin only", reviewer: spec review round 2
Plan baseline: Design §4 as approved: file-classroom reads admin-only; skill API clients unspecified.
Runtime evidence: debian deployment has no OpenClaw/skill client configured; all courses were built in the web UI (persistence documents). `POST /api/generate-classroom` and the file-classroom routes were not called during testing (app logs 2026-09-26).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| Skill API (`POST/GET /api/generate-classroom*`, `/api/classroom*`, `/api/classroom-media/*`) | open to any caller | admin-only via `ownerIdOr401` + admin check; external/tagged clients unsupported in auth mode (documented) | service bearer token (`AUTH_SERVICE_TOKEN`) accepted in addition to admin identity, exempted in middleware; classrooms attributed to a configured member |
Question D18:
D18 — 外部 skill API（OpenClaw 等）喺登入模式點處理？
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: OpenMAIC 有一套俾外部 AI 助手（例如 OpenClaw）用嘅 API，可以喺 WhatsApp 等地方叫佢整課。呢啲客戶端冇 Tailscale 身份，開咗登入就會被擋。你呢部機而家冇用呢個功能。A 係登入模式下只有家長喺瀏覽器可以用，外部客戶端唔支援；B 係另外加一條服務鑰匙俾外部客戶端用。
Stakes if we pick wrong: 揀 A 將來想用 OpenClaw 整課就要再加功能；揀 B 而家就要多做同維護一條未用到嘅鑰匙。
Recommendation: A 因為而家冇人用，冇必要為未有嘅需求開多一條入口。
Completeness: A=8/10, B=10/10
Net: 關閉未用嘅入口，定預先為將來開一條。
Header: Skill API
Options:
A) Admin-only (recommended)
✅ 登入模式下呢幾個 API 只有家長帳戶喺瀏覽器可以用，外部客戶端明確寫明唔支援，入口最少（human: ~2 小時 / CC: ~10 分鐘）。✅ 冇多一條鑰匙要保管。❌ 將來想用 OpenClaw 喺 WhatsApp 整課，要再開發服務鑰匙。
B) Service token
✅ 加一條 AUTH_SERVICE_TOKEN，外部客戶端帶住就可以用，整出嚟嘅課歸指定成員。✅ 將來接 OpenClaw 即用（human: ~1 日 / CC: ~40 分鐘）。❌ 多一條要保管嘅鑰匙同一段 middleware 例外，而家冇人用。

State: approved
Actual answer: B) Service token (D18, 2026-09-26)
Accepted scope: New optional env `AUTH_SERVICE_TOKEN` (≥32 bytes) and `AUTH_SERVICE_OWNER_LOGIN` (must be in `AUTH_ADMIN_LOGINS` or a registered member; required when the token is set, else boot fails). In auth mode the skill API routes (`POST/GET /api/generate-classroom*`, `GET /api/classroom`, `/api/classroom-media/*`) accept either a signed admin identity or `Authorization: Bearer <AUTH_SERVICE_TOKEN>` (constant-time compare at the route); middleware lets requests carrying a Bearer header through to these routes only. File classrooms created with the token are attributed to `AUTH_SERVICE_OWNER_LOGIN` (recorded in a small `service_classrooms(classroom_id, owner_id, created_at)` table) and readable by that member, admins, and the token. Missing/wrong token and no identity → 401; authenticated but not allowed → 404. Unit tests for token accept/reject, wrong-route rejection, attribution and read access.
History: none

### R2-5/6: Startup validation for mismatched or incomplete auth configuration
Finding: 4, P1, confidence 9/10, Design §1 "Startup validation" and §6 (client runs only when NEXT_PUBLIC_PERSISTENCE=1), reviewer: spec review round 2
Plan baseline: Design §1 validates mode, secret, admin list and shared-owner conflict only.
Runtime evidence: `lib/persistence/bootstrap.ts:31-46` gates the client learner-key path on `isBrowserPersistenceEnabled()`; Next inlines `NEXT_PUBLIC_*` at build time, so server code sees the build value of `NEXT_PUBLIC_AUTH_MODE`.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| `AUTH_MODE` set but build lacks `NEXT_PUBLIC_AUTH_MODE` (or the reverse) | not checked | boot fails with a message naming both values | warning logged, app starts |
| `AUTH_MODE` without `DATABASE_URL` | not checked | boot fails | warning logged |
| `NEXT_PUBLIC_AUTH_MODE` without `NEXT_PUBLIC_PERSISTENCE=1` | not checked | boot fails | warning logged |
| Tests | none | startup-validation unit tests for each case | same cases, asserting warnings |
Question D19:
D19 — 設定唔一致時要拒絕啟動，定只係警告？
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: 登入要三樣嘢配合：伺服器設定 AUTH_MODE、build 時嘅 NEXT_PUBLIC_AUTH_MODE、同埋伺服器資料庫。任何一樣唔對，小測同對話記錄會靜靜失敗（403），你只會見到「冇反應」。A 係一發現唔對就拒絕啟動，並講明邊個設定有問題；B 係照開，只寫警告落 log。
Stakes if we pick wrong: 揀 B，設定錯咗都會正常開到，學生做小測冇記錄都冇人知。
Recommendation: A 因為設定錯誤應該喺部署一刻就爆出嚟，而唔係等用家發現資料唔見咗。
Completeness: A=10/10, B=6/10
Net: 早啲大聲失敗，定靜靜咁出錯。
Header: Boot validation
Options:
A) Fail boot (recommended)
✅ 三種設定錯誤（登入模式唔一致、冇資料庫、冇開伺服器儲存）都會令 app 拒絕啟動，錯誤訊息講明邊個變數有問題。✅ 每種情況都有單元測試（human: ~3 小時 / CC: ~10 分鐘）。❌ 設定錯咗就完全開唔到網站，要改好先用得。
B) Warn only
✅ App 照常啟動，錯誤寫入 log，唔會因為設定問題令網站停止。✅ 同樣有測試確認會出警告（human: ~2 小時 / CC: ~8 分鐘）。❌ 小測同對話記錄會靜靜失敗，冇人睇 log 就唔會發現。

State: approved
Actual answer: A) Fail boot (D19, 2026-09-26)
Accepted scope: `instrumentation.ts` startup validation fails boot with a message naming the variables when: `AUTH_MODE` and the build-inlined `NEXT_PUBLIC_AUTH_MODE` disagree (either direction); `AUTH_MODE` is set without `DATABASE_URL`; `NEXT_PUBLIC_AUTH_MODE` is set without `NEXT_PUBLIC_PERSISTENCE=1`. Unit tests cover each case plus the valid combination and the feature-off case.
History: none

### R2-7: Cut-over timing and pre-cutover student content
Finding: 5, P2, confidence 8/10, Design §7 mapping and "The Assignment" (student builds a lesson before code lands), reviewer: spec review round 2
Plan baseline: Design Assignment: student builds a lesson before code lands; Design §7 maps pre-cutover student content to the student via the script, which aborts on owner_material rows.
Runtime evidence: debian DB 2026-09-26: two anon owners (both the parent's test browsers), zero `owner_material` rows; the student has not opened the site.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| Order of cut-over vs Assignment | Assignment first | cut over first (this branch deployed before the student's first visit); Assignment runs afterwards under the student's own account | Assignment first; student told not to upload materials |
| Pre-cutover student content | mapped by script | none exists, nothing to map | mapped by script; lesson with materials is declared disposable |
| Post-check | moved courses open for the parent | each moved course opens for its new owner | same as A |
Question D20:
D20 — 先上線定先俾學生試？
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: 原本 Assignment 叫學生喺新功能上線之前先用一次。但咁樣學生整嘅課會屬於一個匿名身份，上線時要搬，而且有上載材料就搬唔到。而家學生未開過網站，A 係先上線，學生第一次用就已經係自己帳戶，冇嘢要搬；B 係照原本次序，叫學生唔好上載材料。
Stakes if we pick wrong: 揀 B 而學生上載咗材料，嗰堂課就搬唔到佢帳戶，要重整。
Recommendation: A 因為學生未開始，先上線可以完全避免搬資料嘅風險。
Completeness: A=10/10, B=7/10
Net: 先上線零搬遷，定照原次序但要限制學生。
Header: Cut-over order
Options:
A) Cut over first (recommended)
✅ 今次實作完成就上線，學生第一次開網站已經用自己帳戶，冇匿名內容要搬。✅ 上線後檢查每堂搬過嘅課都開到俾新主人（human: 0 額外 / CC: 0 額外）。❌ Assignment 嘅觀察會發生喺新版本，唔係現有版本。
B) Assignment first
✅ 照原本設計，學生喺舊版本試用，觀察結果唔受新登入影響。✅ 可以比較上線前後體驗（human: ~1 小時 / CC: ~10 分鐘 額外搬遷）。❌ 要叫學生唔好上載材料，否則嗰堂課要作廢或者另外開發搬遷。

State: approved
Actual answer: A) Cut over first (D20, 2026-09-26)
Accepted scope: Deploy this branch (cut-over sequence R2-8) before the student's first visit; the Assignment runs afterwards under the student's own account; only the two existing anon owners are reassigned (both → parent); post-check: each moved course opens for its new owner.
History: none

### R2-11: Family page when a quiz changed or the course was deleted
Finding: 6, P2, confidence 8/10, Design §5 quiz-results ("total = sum of question points from that quiz scene"), reviewer: spec review round 2
Plan baseline: Design §5: earned = sum of results[].earned, total from the quiz scene; attempts without results show "in progress".
Runtime evidence: `packages/@openmaic/dsl` runtime contract: `sceneId` anchors are best-effort and may dangle after edits; tombstoned stages keep `stage_meta.deleted_at`.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| Quiz scene missing or question ids changed | unspecified | show earned with total "—" and a "quiz changed since this attempt" note | show earned only, no note |
| Attempts on a deleted course | unspecified | listed with a "deleted course" label | hidden |
Question D21:
D21 — 家長頁點樣顯示「小測已改」或者「課程已刪」嘅成績？
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: 家長頁用課程入面嘅小測計總分。如果之後改咗或者刪咗小測，總分就計唔返；如果成堂課刪咗，舊成績仍然喺資料庫。A 係照顯示得分、總分寫「—」加註「小測已改」，刪咗嘅課標明「已刪除」但保留記錄；B 係只顯示得分、刪咗嘅課嘅成績收埋。
Stakes if we pick wrong: 揀 B，家長會見唔到學生之前喺已刪課程嘅努力，亦唔知道總分點解唔見咗。
Recommendation: A 因為家長檢視嘅重點係完整睇到學生做過咩，保留同標明比收埋好。
Completeness: A=10/10, B=7/10
Net: 保留並標明，定收埋簡化。
Header: Quiz edge cases
Options:
A) Keep and label (recommended)
✅ 小測改咗：顯示得分同「—」總分，註明「小測已改」；課程刪咗：成績保留並標「已刪除課程」。✅ 家長睇到學生完整嘅學習記錄（human: ~2 小時 / CC: ~10 分鐘）。❌ 家長頁會有一啲唔完整嘅行，要睇註解先明。
B) Hide and simplify
✅ 刪咗嘅課嘅成績唔顯示，小測改咗只顯示得分，頁面最整齊。✅ 實作最少（human: ~1 小時 / CC: ~5 分鐘）。❌ 家長見唔到學生喺已刪課程嘅記錄，總分消失亦冇解釋。

State: approved
Actual answer: A) Keep and label (D21, 2026-09-26)
Accepted scope: Quiz-results rows: when the attempt's quiz scene is missing or any answered question id is absent from it, show earned with total "—" and a "quiz changed since this attempt" note; attempts on tombstoned courses are listed with a "deleted course" label (name from `document_stages`). Unit tests for both cases.
History: none

### T1: End-to-end depth for the login, sharing and Family flows
Finding: 7, P2, confidence 8/10, Test review (E2E matrix: auth and data-access flows spanning bridge → app → Postgres → UI), reviewer: plan-eng-review Section 3
Plan baseline: Approved design success criteria (D14) list multi-member checks; test depth unspecified beyond "integration tests signed directly with the secret".
Runtime evidence: repo has vitest (`vitest.config.ts`, `tests/**/*.test.ts`) and Playwright (`playwright.config.ts`, `e2e/`); the Mac has no Docker/Postgres; debian runs the full stack and has Playwright in `node_modules` (browsers not installed).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| Unit + route tests (vitest, Mac) | required by approved design | included | included |
| Live multi-member smoke script on debian (Node script signing headers for 3 simulated members against 127.0.0.1:3000, plus real identity through the tailnet URL) | implied by success criteria | included | included |
| Playwright E2E on debian for UI flows (sign-in chip, Share dialog, Shared with me, Family page, notice page) with signed headers per member | none | not included | included (`e2e/auth-*.spec.ts`, run on debian after deploy) |
Question D22:
D22 — 登入、分享同家長頁要唔要加 Playwright 端到端測試？
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: 單元測試會檢查每個函數同 API，debian 上面亦會行一個腳本，扮三個成員逐個試權限。A 就停喺呢度。B 再加 Playwright：用真瀏覽器逐個畫面試「分享對話框」「分享俾我嘅課」「家長頁」「冇登入時嘅提示頁」。gstack 規則建議登入同資料權限呢類流程做端到端測試。
Stakes if we pick wrong: 揀 A，API 正確但畫面可能有 bug（例如分享掣唔見咗），要等你自己用先發現。
Recommendation: B 因為登入同權限係最唔可以出錯嘅地方，多 1 個鐘換真瀏覽器驗證值得。
Completeness: A=8/10, B=10/10
Net: 多一層真瀏覽器測試，換畫面層面嘅保證。
Header: E2E depth
Options:
A) Unit + smoke
✅ Mac 上 vitest 單元同 API 測試，加 debian 上三個模擬成員嘅權限腳本，覆蓋所有權限規則（human: ~2 日 / CC: ~1.5 小時）。✅ 唔使喺 debian 裝瀏覽器。❌ 畫面流程（分享對話框、家長頁）冇自動測試，要靠人手睇。
B) Add Playwright E2E (recommended)
✅ A 嘅全部，再加 debian 上 Playwright 真瀏覽器測試：登入標記、分享對話框、分享俾我、家長頁、提示頁，每個成員用各自簽名身份（human: ~3 日 / CC: ~2.5 小時）。✅ 畫面 bug 喺上線前捉到。❌ 要喺 debian 裝 Playwright 瀏覽器（約 150MB），測試時間長啲。

State: approved
Actual answer: B) Add Playwright E2E (D22, 2026-09-26)
Accepted scope: vitest unit and route tests on the Mac; live multi-member smoke script on debian (3 simulated members signed with the secret against 127.0.0.1:3000, plus the real identity through the tailnet URL); Playwright E2E specs `e2e/auth-*.spec.ts` run on debian after deploy (Chromium installed there) covering the identity chip, notice page, Share dialog, Shared with me and the Family page, each member with its own signed headers.
History: none

### O1: Pi chat whiteboard uses the development token and a client learner key
Finding: 8, P1, confidence 9/10, `app/api/chat/pi/route.ts:190-199` (`authenticatePersistenceHeaders(req.headers)` gated on `PERSISTENCE_DEV_TOKEN`), reviewer: Codex outside voice (verified by parent)
Plan baseline: Design §6 moves only `/api/persistence/runtime` to the signed principal.
Runtime evidence: route quoted above; the whiteboard runtime store is then used with `principal?.learnerKey` from the client header.
Comparison grid:
| Choice | Current | A Apply | B Keep | C Investigate | D Defer |
|---|---|---|---|---|---|
| Pi chat whiteboard principal in auth mode | dev token + client `x-learner-key` | signed identity → account learner key via the same helper as persistence; conflicting header ignored/refused; test for conflicting signed/header identities | unchanged | ≤30 min audit of every `authenticatePersistence*` caller, then return | unresolved |
Question D23:
D23 — Pi 聊天白板要唔要改用簽名身份？（Codex #1）
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: 課堂聊天入面有個白板功能，佢自己用舊方法認人：一個大家都知道嘅 dev token 加瀏覽器自己報嘅學生編號。即係登入之後，有心人仍然可以扮其他學生改佢嘅白板。A 係改成用同一套簽名身份。
Stakes if we pick wrong: 唔改嘅話，登入保護喺白板呢度有漏洞，學生之間可以互相搞亂白板記錄。
Recommendation: A 因為身份應該全站一致，改動細而且有現成嘅 helper。
Note: options differ in kind, not coverage — no completeness score.
Net: 堵住最後一個舊式認人入口。
Header: Pi whiteboard auth
Options:
A) Apply (recommended)
✅ 登入模式下白板用簽名身份嘅帳戶學習編號，瀏覽器報嘅編號唔再算數，並加測試（human: ~3 小時 / CC: ~15 分鐘）。✅ 全站只有一套認人方法。❌ 多改一個上游檔案（Pi chat route）。
B) Keep current
✅ 唔使改 Pi chat 嘅 code。✅ 少一個上游衝突點。❌ 登入後白板仍然可以被冒充。
C) Investigate first
✅ 用最多 30 分鐘搵晒所有仲用舊方法認人嘅地方先決定。✅ 可能發現更多同類入口。❌ 延遲決定，呢項暫時唔改。
D) Defer
✅ 呢次唔處理，記錄低之後再算。✅ 實作最快。❌ 上線後白板有已知漏洞。

State: approved
Actual answer: B) Keep current (D23, 2026-09-26)
Accepted scope: none. Pi chat whiteboard keeps the development-token + client `x-learner-key` principal; documented as a known residual in `docs/auth-signed-identity.md` (a signed-in member who knows the public dev token could write another learner's whiteboard partition). The client sends the account learner key in auth mode, so normal use stays per-person.
History: none

### O2: Server-rendered video exports are readable by job id
Finding: 9, P1, confidence 9/10, `app/api/export-video/render/[jobId]/download/route.ts:20` (GET streams `${render}/render/${jobId}/download` with no identity check); status and cancel routes likewise; reviewer: Codex outside voice (verified by parent)
Plan baseline: Design §4 row "Export (PPTX, ZIP, video) … built in the browser … unchanged".
Runtime evidence: route quoted above; render-service has no auth.
Comparison grid:
| Choice | Current | A Apply | B Keep | C Investigate | D Defer |
|---|---|---|---|---|---|
| Render job access in auth mode | anyone with the job id | job registry `export_jobs(job_id, owner_id, stage_id, created_at)` written when the render is requested; status/download/cancel only for that owner or an admin, else 404; a recipient keeps access to exports they made themselves | unchanged | ≤30 min review of render flows, then return | unresolved |
Question D24:
D24 — 影片匯出要唔要綁定擁有人？（Codex #2）
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: 匯出 MP4 係伺服器幫你 render，完成後用一條有編號嘅 link 下載。而家任何人拎到呢條 link 都下載得到，唔理佢有冇權睇嗰堂課。A 係記低邊個開始 render，只有佢同家長可以睇進度、下載或者取消。
Stakes if we pick wrong: 唔改嘅話，影片 link 一流出去，未被分享嘅成員都可以睇到課程內容。
Recommendation: A 因為同課程權限一致，實作只係一個小表加三個 route 檢查。
Note: options differ in kind, not coverage — no completeness score.
Net: 影片跟課程一樣有權限。
Header: Video export access
Options:
A) Apply (recommended)
✅ 開始 render 時記錄擁有人，進度、下載、取消只限佢同家長，其他人 404，加測試（human: ~4 小時 / CC: ~20 分鐘）。✅ 同課程權限一致。❌ 多一個小表同三個上游 route 要改。
B) Keep current
✅ 唔使改匯出流程。✅ 少上游衝突。❌ 影片 link 可以繞過課程權限。
C) Investigate first
✅ 用最多 30 分鐘睇清楚 render 流程先決定。✅ 可能搵到更簡單做法。❌ 延遲決定，呢項暫時唔改。
D) Defer
✅ 呢次唔處理，之後再算。✅ 實作最快。❌ 上線後影片有已知漏洞。

State: approved
Actual answer: A) Apply (D24, 2026-09-26)
Accepted scope: In auth mode, render requests record `export_jobs(job_id, owner_id, stage_id, created_at)` for the signed caller; `GET` status, `GET .../download` and cancel under `/api/export-video/render/[jobId]` are allowed only for that owner or an admin, otherwise 404 (401 without identity). A member keeps access to exports they created even after a share is removed. Feature off: routes unchanged. Unit tests for owner, admin, other member and no identity.
History: none

### O3: The host-network guard is polling, not prevention
Finding: 10, P1, confidence 8/10, this file R2-1 accepted scope (check "every 10 minutes"), reviewer: Codex outside voice
Plan baseline: R2-1 approved (D16): check at start and every 10 minutes; Premise 3 wording unchanged.
Runtime evidence: `docker events` streams container start events in real time; the bridge user (clawdbot) is in the docker group.
Comparison grid:
| Choice | Current | A Apply | B Keep | C Investigate | D Defer |
|---|---|---|---|---|---|
| Guard mechanism | poll every 10 min | subscribe to `docker events` (container start/network connect) and re-check immediately, plus 60 s resync; bridge refuses (503) while any unlisted host-network container runs; guard failure (events stream lost) → refuse until resynced | poll every 10 min | ≤1 h prototype of a per-connection process check (would need the bridge to run as root) | unresolved |
| Premise 3 wording | "other containers cannot forge" | narrowed: "host-network root containers are refused within about a second of starting; the tiny race window is accepted" | unchanged (overstated) | unchanged pending | unchanged |
Question D25:
D25 — 容器檢查由「每 10 分鐘」改成「即時事件」？（Codex #3）
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity；D16 已批准自動檢查。
ELI10: Codex 指出每 10 分鐘先檢查一次係「監察」唔係「預防」：危險容器可以喺兩次檢查之間偷偷做嘢，短命嘅容器更加捉唔到。A 改成聽 docker 嘅即時事件，容器一啟動就即刻檢查，失去事件連線就暫停服務；並老實將前提改成「大約一秒內拒絕」。
Stakes if we pick wrong: 保持 10 分鐘，理論上有 10 分鐘空窗可以冒充家長。
Recommendation: A 因為即時事件幾乎消除空窗，而且唔使橋接用 root 行。
Note: options differ in kind, not coverage — no completeness score.
Net: 由定時巡邏變即時警報。
Header: Guard mechanism
Options:
A) Apply (recommended)
✅ 聽 docker events，容器一開就檢查，每 60 秒再核對一次，事件中斷就停止服務直到恢復，前提改為「約一秒內拒絕」（human: ~4 小時 / CC: ~20 分鐘）。✅ 短命容器都捉到。❌ 仍有極短（毫秒級）空窗，要喺文件承認。
B) Keep current
✅ 維持 D16 嘅每 10 分鐘檢查，最簡單。✅ 冇新增依賴。❌ 最多 10 分鐘空窗，短命容器可能完全冇被發現。
C) Investigate first
✅ 用最多 1 小時試做「每條連線都查程式身份」嘅方法（要 root）。✅ 可能做到完全預防。❌ 橋接要以 root 行，保安風險另一種形式增加。
D) Defer
✅ 呢次唔改，保持 D16。✅ 實作最快。❌ 已知嘅空窗照留。

State: approved
Actual answer: A) Apply (D25, 2026-09-26)
Accepted scope: Replaces the 10-minute polling of R2-1: the bridge subscribes to `docker events` (container start, network connect) and re-checks immediately, resyncs every 60 s, and refuses service (503) while any running container with host networking is not listed in `BRIDGE_TRUSTED_HOST_NET`; if the events stream drops, the bridge refuses service until it has reconnected and resynced. Premise 3 reworded: "host-network root containers are refused within about a second of starting; the remaining millisecond race is accepted". Tests: guard state machine with a fake events source (start event, stream loss, resync, allow-list).
History: R2-1 accepted scope (D16) specified polling every 10 minutes; superseded by D25 for the check mechanism only.

### O4: Quiz totals can silently change when points change
Finding: 11, P2, confidence 8/10, this file R2-11 accepted scope (detect changes by missing question ids only); `lib/quiz/grading.ts:3` results carry earned marks but no denominator, reviewer: Codex outside voice
Plan baseline: R2-11 approved (D21): missing scene or missing answered id → total "—" with note; deleted course labelled.
Runtime evidence: `QuizAttemptPayload` (`lib/quiz/runtime.ts:18-23`) stores `results[].earned` only; payload validator checks phase and answers only, so extra fields are accepted.
Comparison grid:
| Choice | Current | A Apply | B Keep | C Investigate | D Defer |
|---|---|---|---|---|---|
| New attempts | no snapshot | client writes `totalPoints` and `quizFingerprint` (hash of question ids + points) into the submitted payload; Family page uses the snapshot | unchanged | ≤30 min check of the quiz write path, then return | unresolved |
| Legacy attempts (no snapshot) | total from current scene if ids match | total "—" (unknown) | total from current scene if ids match | unchanged pending | unchanged |
Question D26:
D26 — 小測交卷時要唔要記低當時嘅總分？（Codex #4）
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity；D21 已批准「小測改咗就標註」。
ELI10: D21 只係檢查題目編號有冇變。但如果只係改咗分數（例如每題由 1 分變 2 分）或者加咗題目，舊成績 8/10 會靜靜變成 8/20。A 係交卷嗰刻把總分同小測指紋一齊存低，之後永遠用當時嘅總分；舊記錄冇存就顯示「—」。
Stakes if we pick wrong: 唔改嘅話，家長可能見到錯誤嘅低分，誤會學生表現。
Recommendation: A 因為成績要反映學生當時面對嘅小測，只係多存兩個欄位。
Note: options differ in kind, not coverage — no completeness score.
Net: 用交卷時嘅快照，杜絕分數被後改扭曲。
Header: Quiz score snapshot
Options:
A) Apply (recommended)
✅ 新交卷記錄存低總分同小測指紋，家長頁用快照；冇快照嘅舊記錄總分顯示「—」，加測試（human: ~3 小時 / CC: ~15 分鐘）。✅ 分數永遠準確。❌ 要改上游小測寫入 code（lib/quiz）。
B) Keep current
✅ 維持 D21，唔改小測寫入。✅ 少上游衝突。❌ 只改分數唔改題號時，舊成績會被錯算。
C) Investigate first
✅ 用最多 30 分鐘睇清楚小測寫入流程先決定。✅ 可能有更少改動嘅做法。❌ 延遲決定。
D) Defer
✅ 呢次唔處理。✅ 實作最快。❌ 已知會有錯誤分數嘅情況。

State: approved
Actual answer: A) Apply (D26, 2026-09-26)
Accepted scope: When a quiz attempt is submitted, the client adds `totalPoints` (sum of `points ?? 1` of the scene's questions at that moment) and `quizFingerprint` (hash of question ids and points) to the submitted `QuizAttemptPayload`. The Family page uses the snapshot total; attempts without a snapshot (legacy) show total "—". A fingerprint that differs from the current scene adds the "quiz changed since this attempt" note from D21. Written only when `NEXT_PUBLIC_AUTH_MODE` is set, so feature-off payloads stay byte-for-byte unchanged (approved design constraint). Tests: payload snapshot on submit, Family page with snapshot, legacy attempt, changed points with same ids.
History: R2-11 accepted scope (D21) derived totals from the current scene when ids matched; superseded by D26 for totals.

### O5: Owner reassignment can collide on folder and skill names
Finding: 12, P2, confidence 7/10, `packages/@openmaic/storage/src/document/pg.ts:121` (unique normalised folder name per owner) and `skill/pg.ts:71` (unique live skill name per owner), reviewer: Codex outside voice
Plan baseline: R2-8 cut-over sequence and Design §7 script (moves folders and skills; aborts only on owner_material).
Runtime evidence: debian DB 2026-09-26: neither anon owner has `document_folders` or `agent_user_skill` rows, so no collision can occur in this migration.
Comparison grid:
| Choice | Current | A Apply | B Keep | C Investigate | D Defer |
|---|---|---|---|---|---|
| Collision handling | none (transaction would fail) | read-only preflight (run before stopping the app) that lists folder/skill name collisions and refuses to proceed; no automatic merge | none | ≤30 min design of an automatic merge/rename policy | unresolved |
Question D27:
D27 — 搬資料之前要唔要先檢查名稱撞車？（Codex #5）
Project/branch/task: Jimmy974/OpenMAIC，feat/tailscale-identity。
ELI10: 兩個舊身份嘅資料要合併入家長帳戶。如果兩邊都有同名嘅資料夾或者 skill，資料庫規則會令成個搬遷失敗。今次兩邊都冇資料夾同 skill，所以唔會發生，但 script 將來可能再用（例如學生換機）。A 係喺停機之前先行一個唔改資料嘅檢查，有撞名就停低並列出。
Stakes if we pick wrong: 唔檢查的話，將來重用 script 撞名時會喺停機後先失敗，要還原備份。
Recommendation: A 因為檢查喺停機前行，零風險，而且 script 會重用。
Note: options differ in kind, not coverage — no completeness score.
Net: 先查後搬，避免停機後先發現問題。
Header: Migration preflight
Options:
A) Apply (recommended)
✅ 搬遷前先行唯讀檢查，列出同名資料夾或 skill 並拒絕繼續，唔會自動合併（human: ~1 小時 / CC: ~5 分鐘）。✅ 喺停機之前就知道有冇問題。❌ 撞名時要人手改名先再搬。
B) Keep current
✅ 今次資料冇撞名，唔使多寫。✅ 最快。❌ 將來重用 script 撞名會喺停機後失敗。
C) Investigate first
✅ 用最多 30 分鐘設計自動合併或改名規則。✅ 將來撞名都可以自動處理。❌ 延遲決定，今次用唔到。
D) Defer
✅ 呢次唔處理。✅ 實作最快。❌ 將來重用 script 有風險。

State: approved
Actual answer: A) Apply (D27, 2026-09-26)
Accepted scope: `scripts/reassign-owner-preflight.sql` (read-only) runs before the app is stopped; for each (from, to) pair it lists folder-name collisions (normalised, per owner) and live skill-name collisions, plus any `owner_material` rows, and the cut-over does not proceed if any are found. No automatic merge or rename. Cut-over step 0 added before "stop the app".
History: none

### TODO-1: Company deployment with company SSO
Finding: TODO proposal, P3, confidence 9/10, Design Premise 1 ("company deployment can later use company SSO on its own infrastructure"), reviewer: plan-eng-review final planning
Plan baseline: none (new TODO proposal)
Runtime evidence: no `TODOS.md` existed in the repo.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| Company SSO deployment | not tracked | added to TODOS.md (P3, M) | not tracked | built in this PR |
Question D28: see D28 in this review (TODO: company SSO).
Header: TODO: company SSO
Options:
A) Add to TODOS.md (recommended)
B) Skip
C) Build it now

State: approved
Actual answer: A) Add to TODOS.md (D28, 2026-09-26)
Accepted scope: `TODOS.md` created with the "Company deployment with company SSO" item (P3, Effort M).
History: none

Approval readiness: PASS — checked R2-1 (D16), R2-2 (D17), R2-3 (D18), R2-5/6 (D19), R2-7 (D20), R2-11 (D21), T1 (D22), O1 (D23), O2 (D24), O3 (D25), O4 (D26), O5 (D27), TODO-1 (D28); factual/required-proof amendments R2-4, R2-8, R2-9, R2-10 carried from the approved design (D14); regression contract "feature off: full upstream suite passes unchanged and no new client requests" carried from the approved design success criteria (D14).

## Review body

### Scope Challenge
Scope accepted as-is (full scope, D6; Original arrangement, D15). Findings from the spec review (R2-1 … R2-11) resolved above.

### 1. Architecture review
Findings: bridge single point of failure (covered by Design §8 `Restart=always` + health check, no decision needed); SSE/long-lived streams through the bridge must not buffer or time out (required proof of Design §8, in tasks); 5-minute signature replay window (accepted residual, app never logs identity headers). Outside voice added O1–O3 (resolved D23–D25).

```
                     ┌──────────────── host (debian) ─────────────────────────────┐
browser ─https─▶ tailscaled (root, :443 serve)                                      │
                     │  strips forged Tailscale-User-*                               │
                     ▼                                                                │
             identity-bridge 127.0.0.1:3001 (clawdbot, Node 24)                      │
               ├─ peer uid == 0 ? (/proc/net/tcp{,6})  ── no ─▶ 403                   │
               ├─ host-net guard (docker events + 60s resync) ── violated ─▶ 503      │
               ├─ drop inbound X-OpenMAIC-Identity-*                                  │
               └─ Tailscale-User-* ─▶ signed X-OpenMAIC-Identity-* (HMAC, ts)         │
                     ▼                                                                │
             127.0.0.1:3000 ─▶ openmaic container (Next.js)                          │
               middleware: UX gate (signature header present? else 401 / notice)      │
               routes: resolveRequestOwnerId / ownerIdOr401 (verify HMAC + skew)       │
                 ├─ 401 AUTH_REQUIRED (missing/forged/stale)                          │
                 ├─ canReadStage(owner | admin | share recipient) ── no ─▶ 404         │
                 └─ Postgres: stage_meta, document_stages, course_shares,             │
                    auth_members, export_jobs, service_classrooms, runtime_sessions   │
                     └────────────────────────────────────────────────────────────────┘
```

### 2. Code quality review
Signature canonicalisation exists twice (bridge `.mjs`, app TS) across a deployment boundary (host script vs container). Shared-code extraction rejected: no practical shared runtime contract across the boundary; drift prevented by shared test vectors (`tests/fixtures/signed-identity-vectors.json`) used by both test suites. No other findings.

### 3. Test review
Framework: vitest (`tests/**/*.test.ts`), Playwright (`e2e/`). Regression contract (D14): feature off → full upstream suite unchanged; fragile files `lib/persistence/bootstrap.ts` (2 reverts) and `app/api/persistence/[...path]/route.ts` (3 reverts) get explicit feature-off tests. **CRITICAL** regression areas: owner resolution without auth, persistence documents/runtime without auth, bootstrap learner key without auth.

```
CODE PATHS (planned)                                   USER FLOWS (planned)
[+] lib/server/auth/signed-identity.ts                 [+] Sign-in
  ├── canonicalise/sign/verify      [GAP→unit vectors]    ├── [GAP] [→E2E] identity chip shows member
  ├── stale / tampered / absent     [GAP→unit]            └── [GAP] [→E2E] no identity → notice page
  └── ownerIdForLogin / admin match [GAP→unit]         [+] Sharing
[+] owner.ts / with-owner / ownerIdOr401                  ├── [GAP] [→E2E] parent shares → student sees
  ├── auth off (unchanged)          [★★★ existing]        └── [GAP] [→E2E] unshare → 404
  └── auth on: valid / 401          [GAP→unit]         [+] Family page (admin)
[+] canReadStage + readGated + decideDocumentAccess       ├── [GAP] [→E2E] member list, courses, quiz rows
  ├── owner/admin/recipient/other   [GAP→unit]            ├── [GAP] quiz changed / deleted course labels
  └── manifest/freshness/status/meta 404 [GAP→route]      └── [GAP] non-admin → 404
[+] persistence runtime principal / merge              [+] Cross-device quiz
  ├── account learner key           [GAP→route]           └── [GAP] [→E2E] attempt on A visible on B
  └── authorizeMerge anon→acct      [GAP→unit]         [+] Error states
[+] shares / members / admin / export_jobs / skill        ├── [GAP] forged headers → 401 (smoke)
    token routes                    [GAP→route]           ├── [GAP] non-root peer → 403 (debian probe)
[+] instrumentation startup validation [GAP→unit]         └── [GAP] boot refuses bad config (unit)
[+] identity-bridge.mjs
  ├── peer uid parser               [GAP→unit fixtures]
  ├── guard state machine           [GAP→unit fake events]
  └── streaming / SSE / upgrade     [GAP→bridge test + debian smoke]
[+] quiz payload snapshot (auth mode) [GAP→unit]

COVERAGE: 0/32 planned paths tested today (new code); every planned path has an assigned test.
Legend: ★★★ behavior + edge + error | [GAP→x] planned test type | [→E2E] Playwright on debian (D22)
```

Test Plan artifact: `~/.gstack/projects/Jimmy974-OpenMAIC/jimmywong-feat-tailscale-identity-eng-review-test-plan-20260926-150700.md`.

### 4. Performance review
No issues found: `canReadStage` adds one primary-key lookup on `course_shares`; admin status is env-based; quiz results use the existing `runtime_sessions_learner_idx`; family scale (2–3 members, tens of courses) rules out N+1 concerns.

### NOT in scope
- Admins editing or deleting members' courses (v1 read-only; open question in design).
- Recipient-side "hide share" (owner controls shares in v1).
- Company deployment with company SSO (TODOS.md, D28).
- Pi chat whiteboard signed principal (kept on dev token by D23; documented residual).
- Material byte migration for `owner_material` (preflight refuses; none exist).
- Docker network changes (removed from v1 after spec review R1-21).

### What already exists
- `resolveRequestOwnerId(req, headers, authenticatedOwnerId?)` seam (`lib/server/agent-runtime/owner.ts:71`) — reused as the single owner choke point.
- `decideDocumentAccess` (`lib/persistence/document-access.ts:58`) and owner-bound `readGated` (`lib/persistence/owner-bound-document-store.ts:167-187,255`) — extended with an optional foreign-read callback rather than rewritten.
- `configureRuntimeStorage({ learnerKey })` (`lib/runtime/config.ts:42`) and `RuntimeStore.mergeLearner` — reused for account learner keys and migration.
- `runtime_sessions_learner_idx` — reused for Family quiz queries.
- `CREATE TABLE IF NOT EXISTS` schema pattern (`lib/persistence/stage-meta.ts:24-55`) — reused for new tables.
- `grok-relay` deployment pattern (host Node, systemd user service, linger) — reused for the bridge.

### Failure modes
| Path | Realistic failure | Handling / test | User sees |
|---|---|---|---|
| Bridge down | process crash | systemd `Restart=always`; ops check | site error until restart (clear, not silent) |
| Guard events stream lost | docker daemon restart | refuse (503) until resync; unit test | clear 503 page |
| Clock skew > 300 s | host NTP failure | 401 + log "stale identity"; unit test | notice page (clear) |
| Secret mismatch bridge/app | edited one env only | every request 401; boot log hint; smoke test | notice page (clear) |
| Flag mismatch / no DB | bad build or env | boot fails (D19); unit tests | deploy fails loudly |
| Share to deleted course | owner deletes | incoming list excludes tombstoned; unit test | course disappears |
| Quiz edited after attempt | teacher edits | snapshot total / "quiz changed" (D21, D26); tests | labelled row |
| Reassignment collision | duplicate names | preflight refuses before stop (D27) | cut-over not started |
No critical gaps (every failure has handling and a test, none is silent).

### Worktree parallelization strategy
| Step | Modules touched | Depends on |
|---|---|---|
| S1 identity core | `lib/server/auth/`, `tests/fixtures/` | — |
| S2 owner/persistence integration | `lib/server/agent-runtime/`, `lib/persistence/`, `app/api/persistence/`, `app/api/stage*` | S1 |
| S3 members/shares/admin/export/skill routes | `app/api/auth/`, `app/api/admin/`, `app/api/shares/`, `app/api/export-video/`, `app/api/classroom*`, `app/api/generate-classroom/` | S1, S2 |
| S4 bridge | `scripts/` | S1 (vectors) |
| S5 client + UI | `lib/persistence/bootstrap.ts`, `lib/quiz/`, `components/`, `app/family/`, `middleware.ts` | S2, S3 |
| S6 ops + cut-over + E2E | `scripts/`, `docs/`, `e2e/`, `Dockerfile`, `docker-compose.yml` | S3, S4, S5 |
Lane A: S1 → S2 → S3 → S5 → S6. Lane B: S4 (after S1 vectors). Execution: launch S1; then A and B in parallel; merge before S6. Conflict flags: `scripts/` shared by S4 and S6 (sequence S4 first).

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1d / CC: ~30min)** — auth core — Signed identity module, owner id, admin match, shared vectors, startup validation
  - Surfaced by: Design §1; R2-5/6 (D19); R2-2 (D17)
  - Files: `lib/server/auth/signed-identity.ts`, `lib/server/auth/config.ts`, `instrumentation.ts`, `tests/fixtures/signed-identity-vectors.json`
  - Verify: `pnpm exec vitest run tests/server/auth`
- [ ] **T2 (P1, human: ~1d / CC: ~30min)** — owner resolution — `resolveRequestOwnerId` auth path, `UnauthenticatedError`, `ownerIdOr401`, workspace action, three direct callers
  - Surfaced by: Design §2; R2-10
  - Files: `lib/server/agent-runtime/owner.ts`, `with-owner.ts`, `lib/workbench/workspace-actions.ts`, freshness/owner-events/session-events routes
  - Verify: owner tests (auth off unchanged, auth on)
- [ ] **T3 (P1, human: ~1.5d / CC: ~45min)** — read access — `canReadStage`, `decideDocumentAccess` callback, `readGated`, stage-meta, status, publish/unpublish disabled
  - Surfaced by: Design §4; R2-4
  - Files: `lib/server/auth/access.ts`, `lib/persistence/document-access.ts`, `lib/persistence/owner-bound-document-store.ts`, `app/api/stage-meta/[stageId]/route.ts`, `app/api/stages/[id]/{status,publish,unpublish}/route.ts`, `app/api/persistence/[...path]/route.ts`
  - Verify: access matrix tests (owner/admin/recipient/other → 200/200/200/404)
- [ ] **T4 (P1, human: ~1d / CC: ~30min)** — learner data — runtime principal from identity, `authorizeMerge`, client account learner key
  - Surfaced by: Design §6
  - Files: `app/api/persistence/[...path]/route.ts`, `lib/persistence/bootstrap.ts`
  - Verify: runtime principal + merge tests; feature-off bootstrap regression test
- [ ] **T5 (P1, human: ~1.5d / CC: ~40min)** — members/shares/admin — tables, `/api/auth/me|members`, shares routes, incoming, admin members/stages/quiz-results (D21, D26 rules)
  - Surfaced by: Design §5; R2-11 (D21); O4 (D26)
  - Files: `lib/server/auth/{members,shares,quiz-results}.ts`, `app/api/auth/*`, `app/api/admin/*`, `app/api/shares/*`, `app/api/stages/[id]/shares/route.ts`
  - Verify: route tests incl. 401/404 and quiz edge cases
- [ ] **T6 (P1, human: ~0.5d / CC: ~20min)** — video export access — `export_jobs` registry and owner/admin checks
  - Surfaced by: O2 (D24)
  - Files: `app/api/export-video/render/**`
  - Verify: owner/admin/other/no-identity tests
- [ ] **T7 (P2, human: ~0.5d / CC: ~25min)** — skill API service token — `AUTH_SERVICE_TOKEN`, attribution table, middleware bearer pass-through
  - Surfaced by: R2-3 (D18)
  - Files: `app/api/generate-classroom/**`, `app/api/classroom/route.ts`, `app/api/classroom-media/**`, `middleware.ts`
  - Verify: token accept/reject, attribution, read-access tests
- [ ] **T8 (P1, human: ~1.5d / CC: ~45min)** — identity bridge — root-peer check, host-net guard (docker events, D25), streaming/SSE/upgrade, systemd unit
  - Surfaced by: Design §8; R2-1 (D16); O3 (D25)
  - Files: `scripts/identity-bridge.mjs`, `scripts/identity-bridge.service`, `tests/scripts/identity-bridge.test.ts`
  - Verify: parser fixtures, guard state machine, vector parity, streaming test
- [ ] **T9 (P1, human: ~2d / CC: ~60min)** — client + UI — middleware UX gate + notice page, identity chip, Shared with me, Share dialog, Family page, quiz snapshot on submit (auth mode)
  - Surfaced by: Design §3, §5; O4 (D26)
  - Files: `middleware.ts`, `components/auth/*`, home page, `components/stage/header-controls.tsx`, `app/family/page.tsx`, `lib/quiz/runtime.ts`
  - Verify: component tests; Playwright specs (T11)
- [ ] **T10 (P1, human: ~0.5d / CC: ~20min)** — cut-over — preflight + reassignment SQL, Dockerfile/compose build arg, ops doc, rollback
  - Surfaced by: Design §7; R2-8; O5 (D27); R2-7 (D20); R2-9
  - Files: `scripts/reassign-owner-preflight.sql`, `scripts/reassign-owner.sql`, `Dockerfile`, `docker-compose.yml`, `docs/auth-signed-identity.md`
  - Verify: preflight on debian (no collisions), post-checks
- [ ] **T11 (P1, human: ~1d / CC: ~40min)** — E2E + smoke — Playwright `e2e/auth-*.spec.ts` and multi-member smoke script on debian
  - Surfaced by: T1 test depth (D22)
  - Files: `e2e/auth-*.spec.ts`, `scripts/auth-smoke.mjs`
  - Verify: run on debian after deploy

### Unresolved decisions
None in this review.

### Completion summary
- Step 0: Scope Challenge — scope accepted as-is
- Architecture Review: 3 issues found (plus 3 from outside voice)
- Code Quality Review: 1 issue found (extraction rejected with rationale)
- Test Review: diagram produced, 32 gaps identified (all planned new code)
- Performance Review: 0 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 1 item proposed to user (accepted)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, completed (5 findings; 4 applied, 1 kept current)
- Parallelization: 2 lanes, 1 parallel / 5 sequential
- Lake Score: 9/9 = coverage choices where the complete option was chosen (D16, D17, D19, D20, D21, D22, D25→A, D26, D27); D18 chose the more complete option; kind choices excluded

### Suppressed findings
- (confidence 4/10) Next 16 warns that `middleware.ts` is being renamed to `proxy`; the gate may need to move when upstream migrates. Not actionable now.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (all resolved in plan) | 13 decisions (D16–D28), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |
| Outside Review | codex (plan) | Independent plan challenge | 1 | issues_found | 5 findings → D23–D27 |

- **OUTSIDE VOICE:** codex completed; 4 findings applied (export_jobs gating, docker-events guard, quiz snapshot, reassignment preflight), 1 kept current (Pi whiteboard dev token, documented residual).
- **UNRESOLVED:** 0
- **VERDICT:** ENG REVIEW COMPLETE — ready to implement (T1–T11).

NO UNRESOLVED DECISIONS
