
## 🆕 v0.19.0 — Whisper tự chọn theo máy + nâng cấp dần + dịch ưu tiên YouTube

- **🎙️ Chấm phát âm bằng Whisper, tự thích nghi máy khách:** mặc định engine là **Whisper**
  (không còn Web Speech làm mặc định — Web Speech chỉ là phương án CUỐI khi thiếu thư viện).
  Khi mở panel, extension **kiểm tra máy trước** (RAM/CPU qua `navigator.deviceMemory` &
  `hardwareConcurrency`) rồi chọn model phù hợp: máy 4GB ít nhân → **tiny**, 4–6GB nhiều nhân →
  **base**, 8GB+ & ≥8 nhân → **small**. Logic nằm ở `lib/whisper-select.js` (có unit test).
- **⚡ Nâng cấp dần (nhanh mà vẫn chuẩn):** nạp **model nhỏ nhất (tiny ~75MB) TRƯỚC** để khách
  ghi âm/chấm điểm được **ngay**, rồi **tự nâng lên model phù hợp máy Ở NỀN**. Worker giữ model
  nhỏ chạy trong lúc tải model lớn, **swap nguyên tử** khi sẵn sàng — không bắt khách chờ tải
  ~480MB mới dùng được. Ô cấu hình máy hiển thị `đang nâng lên SMALL…` rồi cập nhật khi xong.
- **🌐 Dịch ưu tiên phụ đề tự động YouTube:** cả transcript được dịch sẵn bằng bản dịch tự động
  của YouTube (`&tlang=`) — miễn phí, tức thì, không tốn quota. **Model (OpenRouter → DeepL →
  MyMemory) chỉ dùng khi cần dịch lẻ** một từ / một câu theo yêu cầu.
- **🛡️ Giám sát lỗi (Sentry) + rate limit + test tự động:** extension gửi lỗi về Worker `/log`
  (chuyển tiếp Sentry nếu có `SENTRY_DSN`), Worker giới hạn burst 30 lần/60s mỗi user, và bộ
  **unit test (Vitest) chạy tự động qua GitHub Actions** mỗi lần push.

## 🆕 v0.18.0 — Dịch đa nguồn (DeepL/LLM) + sửa bug "Luyện câu treo"

- **🐛 Sửa bug treo:** lần chấm trước treo làm `busy` kẹt → bấm Luyện câu không phản hồi.
  Nay: chấm điểm có **timeout chống treo** (tự giải phóng), bấm Luyện câu **ngắt lần cũ**
  và hủy mic để bắt đầu lại, có phản hồi trạng thái ngay.
- **🌐 Dịch thuật đa nguồn (DeepL → OpenRouter LLM → MyMemory):** tra từ + phụ đề kép.
  Thử lần lượt theo thứ tự ưu tiên, lấy kết quả tốt đầu tiên, có cache. Model OpenRouter
  sửa trong mảng `OR_MODELS` ([sidepanel.js](sidepanel.js)).
- **🔐 Key nhập trong Cài đặt, KHÔNG nhúng mã nguồn:** ô *DeepL key* / *OpenRouter key* lưu
  cục bộ (chrome.storage) — an toàn khi phát hành cho khách.

> Chấm phát âm nhanh nhất = engine **Web Speech** (tức thì). LLM/DeepL chỉ để **dịch**,
> không chấm được phát âm (chúng không xử lý audio).

## 🆕 v0.17.0 — Tích hợp nguồn mở: tô màu tần suất, AnkiConnect, Silero VAD, wav2vec2/GOP

- **🎨 Tô màu từ theo tần suất (kiểu Language Reactor):** từ hiếm/đáng học được highlight nhẹ
  trong câu (dựa danh sách ~500 từ tiếng Đức thông dụng, offline). File `content/freq-de.js`.
- **→ Anki (live) qua AnkiConnect:** ngoài xuất file `.txt`, gửi thẳng thẻ sang Anki đang mở
  (deck "Shadow Deutsch") qua AnkiConnect `localhost:8765`. *Lưu ý:* cần addon AnkiConnect và
  thêm origin `chrome-extension://<id>` vào `webCorsOriginList` của addon.
- **🎙️ Silero VAD (tùy chọn, opt-in):** bật trong *Cài đặt → Silero VAD* để dùng VAD nơ-ron
  (chính xác hơn RMS) cho việc tự dừng ghi âm. Cần chạy `vendor/download-vendor` để tải
  `ort.min.js` + `silero_vad_v5.onnx`. Nếu thiếu/ lỗi → **tự quay về VAD thích nghi (RMS)**,
  không ảnh hưởng luồng hiện tại. Module `vendor/vad-silero.js`.
- **🔬 Chấm phát âm theo âm vị (wav2vec2 + GOP) — phía server:** endpoint mới `POST /score`
  trong `server/app.py` dùng `facebook/wav2vec2-lv-60-espeak-cv-ft` + phonemizer (espeak) để
  chấm theo *âm vị* (chuẩn hơn Kölner). Cần `pip install -r requirements.txt` và cài `espeak-ng`.

## 🆕 v0.16.0 — Giao diện tông tím-teal (kiểu ShadowEcho) + Xuất Anki

- **🎨 Thiết kế lại đơn giản, dễ nhìn:** bảng màu tím-teal điềm tĩnh giống ShadowEcho
  (nền `#140f1d`, tím `#8b7cff`, teal `#46cfc4`), thẻ câu hiện tại nổi bật hơn, bớt màu
  cạnh tranh, nhiều khoảng thở hơn.
- **⬇️ Xuất Anki:** tab *Từ vựng* → nút **Xuất Anki** tạo file `.txt` (tab-separated, có
  directive `#separator`/`#columns`) gồm Từ · Nghĩa · Ngữ cảnh — import thẳng vào Anki.
  Đây là tính năng đặc trưng của Language Reactor / Migaku / asbplayer, chạy 100% offline.

## 🆕 v0.15.0 — Học từ ShadowEcho: vá phụ đề YouTube (POT) + phím tắt + ẩn chữ

- **🔴 Sửa phụ đề tự động YouTube (POT token):** YouTube 2025-2026 bắt buộc *Proof-of-Origin
  token* cho `/api/timedtext`; thiếu nó request trả về rỗng → "Phụ đề tự động" hỏng. Đã viết
  lại `inject/intercept-youtube.js` theo kỹ thuật ShadowEcho: đọc tracklist từ
  `player.getPlayerResponse()`, **bắt POT** từ request thật, **ép YouTube tạo token** (bấm nút
  CC), rồi fetch `&fmt=json3&pot=...&c=WEB&lang=...` ngay trong MAIN world. Cách cũ vẫn giữ
  làm dự phòng.
- **⌨ Phím tắt (keyboard-first):** `Space` nói/chấm, `◀ ▶` câu trước/sau, `▲ ▼` tốc độ,
  `Enter` phát/dừng, `R` nghe mẫu, `L` lặp 1 câu, `B` ẩn chữ, `S`/`Esc` dừng.
- **🙈 Ẩn/làm mờ chữ (tự kiểm tra):** nút 🙈 (hoặc phím `B`) làm mờ câu tiếng Đức — di chuột
  để hiện. Buộc bạn nhớ và tự nói trước khi nhìn (kỹ thuật cốt lõi của ShadowEcho).
- **✂️ Tách câu dài thành từng câu:** phụ đề một dòng chứa nhiều câu sẽ được tách (chia thời
  gian theo độ dài) để shadowing từng câu một.

## 🆕 v0.14.2 — Sửa ghi âm: tự dừng để chấm + chống kẹt Whisper

- **Tự động dừng khi nói xong (VAD thích nghi):** trước đây ngưỡng im lặng cố định `0.015`
  bị `autoGainControl` của mic làm hỏng (khuếch đại tiếng ồn nền lên trên ngưỡng) → bản ghi
  chạy hết 12 giây mới dừng. Giờ **đo nền nhiễu ~400ms đầu** rồi tự đặt ngưỡng → dừng ~0.9s
  sau khi bạn ngừng nói, và **dừng sớm sau 4.5s nếu không nghe thấy gì**.
- **Nút `✅ Tôi nói xong → chấm`:** hiện ngay khi đang ghi âm — bấm để dừng tức thì và chấm
  luôn (kiểu Trancy), không phải chờ VAD.
- **Whisper chưa cài → tự chuyển Web Speech:** nếu `vendor/` chưa có (chưa chạy build-release),
  engine Whisper sẽ **tự fallback sang Web Speech ngay**, không bắt bạn nói 12s rồi mới báo lỗi.
  Ô "Bạn nói" sẽ ghi `webspeech (Whisper chưa cài)` để bạn biết.
- **Nút `⏹ Dừng` giờ tắt mic thật** (trước đây vẫn ghi ngầm trong Side Panel).
- **Web Speech** cũng tự dừng nhanh hơn khi bạn ngừng nói (`onspeechend`) và coi
  "không nghe được" là kết quả rỗng thân thiện thay vì ném lỗi.

> Engine mặc định là **Web Speech** (chạy ngay, không cần tải gì). Whisper chính xác hơn cho
> tiếng Đức nhưng cần chạy `build-release` để nhúng thư viện vào `vendor/`.

## 🆕 v0.10 — Giao diện Chrome Side Panel (kiểu ShadowEcho)

- Bấm **icon Shadow** trên thanh công cụ → mở **Side Panel** dock cạnh phải (không che video).
- Trong panel: lấy phụ đề (Tự động / Live / File), **🎤 Bật mic** (quyền của extension),
  thẻ câu hiện tại + ◀ ⏯ 🔁 ▶ + 🎤 Shadow + 🔊 Nghe + đếm câu, danh sách câu (click để
  nhảy + tự dừng cuối câu), chấm điểm tô màu, tab Từ vựng / Tiến độ.
- Điểm mạnh riêng giữ nguyên: chấm ngữ âm Kölner + Whisper cục bộ + pitch + Netflix/SRT.

# 🎙️ Shadowing Deutsch — Extension cho YouTube & Netflix (v0.9)

Luyện **shadowing** tiếng Đức ngay khi xem YouTube/Netflix: phụ đề theo câu → click
câu → video tự phát đúng đoạn → tự dừng → ghi âm → **Whisper cục bộ** nhận diện →
**chấm điểm ngữ âm chuẩn Kölner Phonetik** (tô màu từng từ) → lặp 3 lần → tự sang câu kế.

> Đây là **bản extension** dùng Side Panel trên YouTube + Netflix, hỗ trợ Whisper
> local). Phần lõi rủi ro cao nhất — **engine chấm điểm ngữ âm** và **parser phụ đề** —
> cần được kiểm tra trên Chrome thật với micro, video và model trước khi phát hành.

---


---

## ⭐ GỬI CHO KHÁCH / PHÁT HÀNH (đọc cái này)

Khách **không bao giờ phải chạy script**. Bạn (người bán) làm 1 lần:

1. Mở thư mục `shadowing-extension`.
2. **Windows:** chuột phải `build-release.ps1` → *Run with PowerShell*
   (hoặc `powershell -ExecutionPolicy Bypass -File build-release.ps1`).
   **mac/Linux:** `bash build-release.sh`.
3. Ra file **`shadowing-extension-release.zip`** đã **nhúng sẵn Whisper** (thư viện
   + WASM trong `vendor/`). Gửi file này cho khách, **hoặc** upload lên
   **Chrome Web Store** (Developer Dashboard → Upload zip).

Khách chỉ cần cài (Web Store: bấm Add; hoặc load unpacked nếu nội bộ). Whisper chạy
ngay; model ~145MB tự tải từ HuggingFace lần đầu rồi cache — đây là lần duy nhất chờ.

> **Vì sao gặp dòng "Whisper chưa sẵn sàng…"?** Vì bản dev chưa có thư viện trong
> `vendor/` (mình không tải kèm để file nhẹ). Chạy `build-release` là hết — hoặc tạm
> đổi Engine sang **Web Speech** (chạy ngay, không cần gì).

---

## 1. Cài đặt (load unpacked)

1. Giải nén thư mục `shadowing-extension` ra **ổ cứng local** (đừng để trong Google
   Drive/Shared Drive đang đồng bộ — Chrome có thể không đọc được).
2. Chrome → `chrome://extensions` → bật **Developer mode** (góc trên phải).
3. **Load unpacked** → chọn thư mục có `manifest.json`.
4. Bấm icon extension → **🎤 Cấp quyền micro** (chỉ làm 1 lần).

## 2. Bật Whisper cục bộ (1 lần) — *hoặc bỏ qua để dùng Web Speech*

Whisper chạy 100% trong máy nhưng cần 2 file đặt sẵn trong `vendor/`:

- **Windows:** mở thư mục `vendor/` → chạy `powershell -ExecutionPolicy Bypass -File download-vendor.ps1`
- **macOS/Linux:** `cd vendor && bash download-vendor.sh`

Script tải `transformers.min.js` + onnxruntime WASM từ **jsDelivr**. Xong thì
`chrome://extensions` → bấm **↻ Reload**. Lần đầu chấm điểm, model Whisper (~145MB)
tự tải từ HuggingFace rồi được cache.

> **Chưa cài vendor?** Vẫn dùng được ngay: trong Side Panel đổi **Engine → Web Speech
> (nhanh)**. Web Speech miễn phí, tức thì, nhưng kém chính xác hơn Whisper với tiếng Đức.

## 3. Dùng

1. Mở video YouTube/Netflix tiếng Đức. Overlay **🎙️ Shadowing Deutsch** hiện góc phải.
2. Lấy phụ đề theo 1 trong 3 cách:
   - **⬇️ Phụ đề tự động** — bắt track thật của trình phát (kỹ thuật asbplayer: chặn
     request mạng, không cào màn hình → hết lỗi trùng/chồng).
   - **🔴 Live (bật CC)** — đọc phụ đề đang hiện (dự phòng, có chống trùng prefix).
   - **📂 File SRT/VTT** — kéo file phụ đề (chắc chắn nhất; dùng được cho cả Netflix/phim).
3. Bấm **🎤 Shadow** trên một câu → phát → tự dừng → nói lại → chấm điểm.
   **↪ Tới đây** chỉ tua đến câu (không ghi âm). Click một **từ** để tra DWDS/LEO + lưu.
4. Tab **Từ vựng** / **Tiến độ** ở đầu Side Panel.


## 3b. Mic & tính năng mới (v0.9.1)

- **🎤 Bật mic:** bấm nút này → trình duyệt hiện hộp xin quyền mic của **extension**
  → bấm **Cho phép**. Ghi âm và nhận diện chạy trong Side Panel nên không còn phụ
  thuộc Permissions-Policy của YouTube/Netflix.
- **☆/★ Thích dòng:** bấm ngôi sao ở mỗi câu để đánh dấu.
- **▶️ Tự luyện dòng đã thích:** chạy vòng shadowing lần lượt qua tất cả câu đã ⭐.
- **🔊 Nghe:** đọc mẫu câu/từ tiếng Đức bằng giọng máy (TTS) để nghe trước khi nói.
- **⏹ Dừng:** dừng vòng luyện / TTS bất cứ lúc nào.

---

## 4. Kiến trúc (đã giải quyết 2 lỗi cũ)

| Vấn đề cũ | Cách bản này xử lý |
|---|---|
| Mic bị Permissions-Policy của YouTube/Netflix chặn | Ghi âm + nhận diện trong **Side Panel** (origin của extension) → trang không chặn được |
| Phụ đề trùng/chồng do cào caption cuộn | **Chặn request phụ đề thật** (json3/TTML) như asbplayer + thuật toán **dedup prefix** khi dùng Live |

```
inject/intercept-youtube.js   (MAIN world)  hijack fetch/XHR -> bắt timedtext json3
inject/intercept-netflix.js   (MAIN world)  hijack fetch/XHR -> bắt TTML/VTT
content/bridge.js             nhận sự kiện -> parse -> gộp câu
content/parsers.js            SRT/VTT/json3/TTML + mergeIntoSentences
content/phonetic.js           Kölner Phonetik + alignment + chấm điểm
content/video-controller.js   điều khiển <video> (YT + Netflix)
content/shadow-engine.js      máy trạng thái play→pause→record→score→repeat→next + Live capture
sidepanel.html/js/css         UI: luyện câu, tra từ, flashcard và tiến độ
content/storage.js            chrome.storage.local: history / savedWords / settings
content/speech.js             proxy nhận diện giữa trang video và Side Panel
background.js                 mở Side Panel khi bấm icon extension
mic-service.js + whisper-worker.js   mic, Web Speech, Server STT và Whisper
```

## 5. Kiểm tra trước khi phát hành

Chạy `node --check` cho các file JavaScript, sau đó load unpacked và dùng nút
**Kiểm tra** trong Side Panel để xác nhận video, phụ đề và quyền microphone.

---

## 6. Đánh giá thẳng thắn — còn thiếu gì & nên kết hợp open-source / API miễn phí nào

**Đang chạy được (MVP):** vòng lặp shadowing đầy đủ, chấm điểm ngữ âm tiếng Đức,
phụ đề đa nguồn, tra từ, lưu tiến độ — trên cả YouTube & Netflix.

**Rủi ro / còn thiếu, theo thứ tự ưu tiên:**

1. **Mic trong Side Panel** cần được cấp quyền một lần bằng nút **Bật mic** trước khi
   chạy chế độ tự luyện. Nếu đã chặn quyền, mở cài đặt extension của Chrome và cho
   phép microphone rồi thử lại.
2. **Phụ đề Netflix** khó hơn YouTube (DRM + URL `?o=` khó nhận diện). Cách **chắc
   chắn** cho Netflix là **kéo-thả file SRT/VTT** — đã hỗ trợ. Nâng cấp sau: tích hợp
   ý tưởng từ **asbplayer** (`killergerbah/asbplayer`) để bắt track Netflix ổn định.
3. **Ngữ điệu (intonation) chuẩn ELSA** hiện chỉ chấm theo *độ biến thiên cao độ* vì
   không có pitch tham chiếu. Để so đúng: trích F0 từ audio gốc đoạn video
   (open-source: **CREPE** / **pYIN** / **Praat-Parselmouth**) rồi so đường cong.
4. **Bản dịch phụ đề kép** (Đức→Việt) chưa bật offline. Free API: **MyMemory**
   (`api.mymemory.translated.net`) hoặc **LibreTranslate** self-host; thêm domain vào
   `connect-src` của CSP. Hiện thay bằng tra từ DWDS/LEO khi click.
5. **Whisper nhanh hơn:** model `whisper-base` ổn trên CPU; muốn nhanh/nhẹ hơn dùng
   **whisper-tiny** hoặc **faster-whisper** (server). Có WebGPU thì transformers.js
   tự tăng tốc.

**Bản đồ open-source nên kết hợp:**

| Mảng | Nguồn mở | Vai trò |
|---|---|---|
| Phụ đề streaming | **asbplayer** (killergerbah) | kỹ thuật bắt track YT/Netflix |
| Phụ đề YouTube (server) | **youtube-transcript-api** (jdepoix) | lấy transcript sạch nếu cần backend |
| STT | **openai/whisper** qua **@xenova/transformers** | nhận diện tiếng Đức cục bộ |
| Ngữ âm | **Kölner Phonetik** (đã tự cài) + **CREPE/pYIN** | chấm phát âm + ngữ điệu |
| Player nhúng | **lite-youtube** (justinribeiro) | nếu sau này tách web app riêng |

## 7. Giới hạn trung thực
**Hành vi runtime** (mic, điều khiển video, intercept, tải model) cần được kiểm tra
trên Chrome thật; YouTube/Netflix có thể thay đổi cấu trúc và cần cập nhật selector.
