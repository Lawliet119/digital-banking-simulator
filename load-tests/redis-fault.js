import { workload } from "./lib/config.js";
export { read, write } from "./lib/client.js";
export const options = workload("redis-fault", __ENV.SMOKE === "1");
