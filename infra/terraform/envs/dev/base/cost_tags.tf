# DBS-143: bật project/env/owner trong Cost allocation tags để Cost Explorer nhóm được chi phí theo tag (ADR-11).
# Miễn phí. Xóa resource (hoặc destroy base) đặt tag về Inactive; dữ liệu chi phí không mất.
resource "aws_ce_cost_allocation_tag" "this" {
  for_each = toset(keys(local.tags))

  tag_key = each.key
  status  = "Active"
}
