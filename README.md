# 賽乒乓本機試跑

## v0.6.14 球團部署與總部啟停

- `firebaseConfig.js` 是各球團的 Firebase Web 設定。中央程式同步時應排除此檔及各站的 `wrangler.toml`。
- 新球團使用自己的 Cloudflare Pages 和空白 D1，綁定名稱為 `TBALL_DB`。複製本程式時，替換 Web 設定與 D1 部署設定，並將 `legacyPilot` 設為 `false`。D1 存放會員、登入及賽事資料。
- 在該站的伺服端設定 `TBALL_OWNER_UID`（為新球團指定的獨立大會識別碼）及 `TBALL_OWNER_CODE_HASH`（大會私密登入代號經正規化後的 SHA-256 小寫十六進位值）。新球團首次登入或註冊時會初始化空白 D1。登入代號僅交付該球團大會。
- Super Admin 登記球團使用該站 `firebaseConfig.js` 裡的實際 `projectId`。總部授權位於 `product_registrations/tball/tenants/{projectId}`，新登記預設停用。站台 API 查驗該球團的 `registered` 與 `active` 後才開放使用。部署前需發布已驗證的總部規則。
- 現有試用站沿用原 D1 與舊站初始化設定。若要讓總部也控管試用站，須先發布總部規則並確認已有有效登記，再將該 Pages 專案的 `TBALL_REQUIRE_HQ` 設為 `true` 並重新部署。
- 在專案根目錄執行 `node build-pages.cjs`，部署 `pages-dist` 時同時打包 `functions/`。

## 網路版 v0.5.1

既有會員以原帳號作為登入代號。登入服務在 Cloudflare Pages 與 D1 執行，保留原 Firebase UID 與既有賽事關聯。測試會員以 test01 至 test30 登入。註冊只需登入代號，系統指派固定會員編號。會員每次報名時填寫該場參賽名稱，各場可不同，參賽名稱不可使用登入代號。

同一瀏覽器以 HttpOnly、Secure、SameSite=Lax Cookie 保留登入 180 天。登出會撤銷該 Cookie 對應的伺服端登入紀錄。登入代號雜湊與登入紀錄儲存在 D1，所有公開名冊及賽事 API 只投影公開名稱。

本機版為 v0.2.1，多人試用版為 v0.3.5。頁首顯示版本號，頁底可展開變更紀錄。本機版展開「本機測試工具」可切換模擬身分。

用瀏覽器開啟 `index.html`，按以下順序試跑。

1. 用大會身分發布公告，設定報名截止日、完賽期限與每隊人數。要快速試跑可設每隊兩人。
2. 切換到「新報名選手」，逐一登記至少四位不同顯示名稱的選手。每次報名完成會切換到該選手。
3. 切回大會，按「截止報名，開始組隊」，從報名者指定兩位隊長與隊名。
4. 切換到各隊長，加入已私下談定的選手。切換到隊員即可自行退隊，該選手仍保有報名資格。原隊要重新加入該選手，需由選手先在「我的隊伍」解除限制。
5. 大會檢查隊伍人數及待組隊選手，再鎖定名單並產生循環對戰表。鎖定後的名單異動交由大會協調。試跑版尚無鎖定後的名單更正介面。
6. 雙方隊長提交排陣後，選手在「我的對戰」逐點提出時間地點。單打兩人、雙打四人都接受後即可登錄局數。對方選手確認後算入該點，大會可以退回有異議的比分。

試跑固定單、雙、單三點，每點五局三勝，三點全確認才計算團體勝敗。排行榜先比勝場，再比總得點，同分規則待定。資料存在開啟頁面的瀏覽器，可用另一個瀏覽器設定檔重新試跑。所有角色皆可切換，請使用虛構資料。

預定雲端環境為 GitHub `tballgame/tball`、Firebase `tball-ef787` 和 Cloudflare Pages `tball-4vi.pages.dev`。本機版尚未接入雲端帳號、Firestore 或 Super Admin。

## Firebase 多人候選版

此版範圍從公告到鎖定隊伍及顯示循環對戰表。後端依已驗證帳號的 Firebase UID 授權。試用環境支援一場賽事、最多 12 隊及 144 人。鎖定後的排陣、約期與賽果仍可在本機版演練。

1. 在 `tball-ef787` 啟用 Firebase Authentication 的電子郵件／密碼登入，加入 Pages 的授權網域，並建立 Firestore。前端將使用者自訂帳號轉為 Firebase 內部識別信箱，使用者不需提供信箱。候選規則禁止用戶端直接存取 Firestore。
2. 在 Cloudflare Pages 專案設定環境變數 `TBALL_OWNER_UID`，值為大會的 Firebase Auth UID。
3. 為 `tball-ef787` 建立專用 Google 服務帳戶，授予 Firestore 文件讀取、建立及更新，以及 `firebaseauth.users.get`、`firebaseauth.users.update`。把服務帳戶 JSON 存為 Pages 加密 Secret `GOOGLE_SERVICE_ACCOUNT`。
4. 在此目錄執行 `node build-pages.cjs` 後，以 Wrangler 部署 `pages-dist` 到 Pages 專案 `tball`。Wrangler 需同時打包此目錄下的 `functions/`。

大會在報名階段可加入 30 位虛構選手。測試選手可以分隊，沒有登入帳號，隊長需由實際建立帳號並報名的人擔任。

`node --test model.test.cjs cloud-domain.test.cjs` 可驗證本機流程與後端規則核心。雲端 IAM、帳密登入及大會密碼重設需部署後驗證。
