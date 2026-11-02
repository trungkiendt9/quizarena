# Hướng Dẫn Đưa Website QuizArena Lên Mạng Để Thử Nghiệm Cùng Sinh Viên

Vì **QuizArena** hoạt động theo cơ chế **đấu trường thời gian thực (WebSocket / Socket.IO)** — giữ kết nối liên tục giữa màn hình Giảng viên và hàng chục điện thoại Sinh viên — bạn cần chạy trên môi trường hỗ trợ **Node.js Server liên tục** (như **Render**, **Railway**, **VPS**, hoặc chạy từ laptop giảng viên qua **Cloudflare Tunnel / Ngrok**).

> ⚠️ **Lưu ý quan trọng:** Không dùng *GitHub Pages* hay *Vercel/Netlify tĩnh* vì các nền tảng đó không duy trì kết nối WebSocket liên tục cho phòng chờ trực tuyến.

---

## Cách 1: Thử nghiệm ngay lập tức trên khung Live Preview hiện tại (0 phút cài đặt)

Ngay lúc này, cửa sổ **Website (Live Preview)** bên cạnh đã có sẵn một đường dẫn công khai dạng `https://3000-...e2b.app`:
1. Trên màn hình Giảng viên, bấm **Mở phòng** ở một bộ đề bất kỳ.
2. Dùng điện thoại (4G hoặc Wi-Fi bất kỳ) **quét trực tiếp Mã QR** trên màn hình phòng chờ (hoặc bấm nút **"Sao chép Link tham gia"** gửi qua Zalo/Teams nhóm lớp).
3. Sinh viên vào thẳng phòng thi trên điện thoại thật và thi đấu ngay lập tức!

---

## Cách 2: Đưa lên Render.com (Miễn phí, có link `.onrender.com` cố định) — KHUYÊN DÙNG

Tôi đã cấu hình sẵn tệp `render.yaml` và `package.json` chuẩn trong mã nguồn để bạn triển khai tự động.

### Bước 1: Tải mã nguồn và đưa lên GitHub
1. Tải tệp nén **`quizarena-deploy.zip`** trong thư mục dự án về máy tính và giải nén.
2. Tạo một kho chứa (Repository) mới trên [GitHub.com](https://github.com) (ví dụ: `quizarena-lop-hoc`).
3. Tải toàn bộ các tệp vừa giải nén lên Repository đó (hoặc dùng lệnh Git):
   ```bash
   git init
   git add .
   git commit -m "Initial QuizArena"
   git branch -M main
   git remote add origin https://github.com/<ten-tai-khoan>/quizarena-lop-hoc.git
   git push -u origin main
   ```

### Bước 2: Kết nối với Render.com
1. Đăng nhập vào [https://render.com](https://render.com) (có thể đăng nhập nhanh bằng tài khoản GitHub).
2. Bấm nút **New +** ➔ chọn **Web Service**.
3. Chọn kho chứa `quizarena-lop-hoc` của bạn.
4. Điền cấu hình (nếu Render chưa tự nhận từ `render.yaml`):
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` (Miễn phí)
5. Bấm **Create Web Service** và đợi khoảng 2 phút.
6. Bạn sẽ nhận được địa chỉ chính thức dạng `https://quizarena-lop-hoc.onrender.com`!

*(Mẹo nhỏ với gói Free của Render: Sau 15 phút không có ai truy cập, máy chủ miễn phí sẽ tạm nghỉ. Trước giờ lên lớp 2 phút, bạn chỉ cần mở trang web lên để máy chủ thức dậy là cả tiết học chạy mượt mà!)*

---

## Cách 3: Đưa lên Railway.app (Tốc độ rất nhanh, không bị ngủ đông)

Dự án đã có sẵn tệp `railway.json` và `Dockerfile`:
1. Truy cập [https://railway.app](https://railway.app) và đăng nhập bằng GitHub.
2. Chọn **New Project** ➔ **Deploy from GitHub repo** ➔ chọn repo `quizarena-lop-hoc`.
3. Sau khi build xong (~1 phút), vào mục **Settings** ➔ **Networking** ➔ bấm **Generate Domain**.
4. Railway cấp ngay tên miền `https://...up.railway.app` tốc độ cao, chịu tải rất tốt cho lớp học 50–150 sinh viên cùng bấm đáp án một lúc!

---

## Cách 4: Chạy ngay trên Laptop Giảng viên & Phát ra Internet bằng Cloudflare / Ngrok

Cách này cực kỳ tiện nếu bạn muốn toàn bộ dữ liệu câu hỏi và bảng điểm nằm trực tiếp trên laptop cá nhân khi mang lên giảng đường:

1. Cài đặt [Node.js 20+](https://nodejs.org/) trên máy tính.
2. Giải nén `quizarena-deploy.zip`, mở Terminal / Command Prompt tại thư mục đó và chạy:
   ```bash
   npm install
   npm run build
   npm start
   ```
   *(Lúc này web đã chạy tại `http://localhost:3000` — nếu sinh viên dùng chung mạng Wi-Fi phòng máy với bạn, chỉ cần vào địa chỉ IP LAN của laptop như `http://192.168.1.x:3000` là chơi được ngay cả khi mất Internet!)*

3. **Nếu sinh viên dùng 4G riêng trên điện thoại**, mở thêm 1 cửa sổ Terminal và chạy lệnh miễn phí của Cloudflare (không cần đăng ký tài khoản):
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
   Cloudflare sẽ cấp ngay một đường link `https://xxxx.trycloudflare.com`. Bạn mở đường link đó trên máy chiếu, Mã QR trên phòng chờ sẽ tự động cập nhật theo đường link này để cả giảng đường quét vào thi đấu!
