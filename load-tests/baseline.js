import { workload } from "./lib/config.js";
export { read, write } from "./lib/client.js";
export const options = workload("baseline", __ENV.SMOKE === "1");
