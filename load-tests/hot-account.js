import { workload } from "./lib/config.js";
import { fixture, transfer, completed } from "./lib/client.js";
export const options = workload("hot-account", __ENV.SMOKE === "1");
export default function () {
  completed(transfer(fixture.customers[0], fixture.customers[1]));
}
