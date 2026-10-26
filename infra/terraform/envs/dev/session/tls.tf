# Dev chưa có tên miền nên chưa có chứng chỉ ACM công khai: dùng chứng chỉ self-signed (RSA 2048, 30 ngày)
# import vào ACM để listener 443 mã hóa đúng NFR-SEC-03. Khóa riêng nằm trong state (bucket đã mã hóa).
resource "tls_private_key" "dev" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "dev" {
  private_key_pem       = tls_private_key.dev.private_key_pem
  validity_period_hours = 720
  allowed_uses          = ["key_encipherment", "digital_signature", "server_auth"]

  subject {
    common_name = "dbs-dev.local"
  }
}

resource "aws_acm_certificate" "dev" {
  private_key      = tls_private_key.dev.private_key_pem
  certificate_body = tls_self_signed_cert.dev.cert_pem
}
