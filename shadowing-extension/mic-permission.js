/* Trang xin quyền micro của extension. Chạy trong TAB (có thanh địa chỉ) nên hộp
 * thoại micro hiện đúng — Side Panel thì không hiện được. Cấp ở đây = cấp cho cả
 * origin chrome-extension://<id>, nên Side Panel dùng được ngay sau đó. */
(function () {
  'use strict';
  const btn = document.getElementById('grant');
  const status = document.getElementById('status');

  function show(kind, html) { status.className = 'status ' + kind; status.innerHTML = html; }

  async function request() {
    btn.disabled = true;
    show('', 'Đang xin quyền…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Dừng track ngay — chỉ cần lấy quyền, Side Panel sẽ tự mở mic khi cần.
      stream.getTracks().forEach((t) => t.stop());
      show('ok', '✅ Đã cấp quyền micro! Quay lại Side Panel và bấm <b>Bật mic</b>. Có thể đóng tab này.');
    } catch (e) {
      const name = (e && e.name) || '';
      if (name === 'NotAllowedError') {
        show('err', '❌ Quyền micro đang bị chặn. Bấm biểu tượng <b>🔒 / 🎤</b> cạnh thanh địa chỉ ở trên → <b>Microphone → Allow</b> → tải lại trang rồi bấm lại.');
      } else if (name === 'NotFoundError') {
        show('err', '❌ Không tìm thấy micro nào trên thiết bị. Kiểm tra micro rồi thử lại.');
      } else if (name === 'NotReadableError') {
        show('err', '❌ Micro đang bị ứng dụng khác chiếm. Đóng app đang dùng micro rồi thử lại.');
      } else {
        show('err', '❌ Lỗi: ' + ((e && e.message) || name || 'không xác định'));
      }
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', request);

  // Tự xin quyền ngay khi mở tab (mở từ Side Panel = có user gesture). Nếu trình duyệt
  // đòi gesture riêng thì người dùng bấm nút "Cho phép micro".
  window.addEventListener('load', () => { request().catch(() => {}); });
})();
