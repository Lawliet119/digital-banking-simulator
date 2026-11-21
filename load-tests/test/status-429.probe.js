// k6 script of status-429.manual.mjs (BL-415): sends 20 transfers through the real lib/client.js and checks that each
// answer really was a 429 (so a timeout or a refused connection cannot pass for one).
import { check } from "k6";
import { fixture, transfer } from "../lib/client.js";

export const options = { vus: 1, iterations: 20 };

export default function () {
  const response = transfer(fixture.customers[0], fixture.customers[1]);
  check(response, { "answer is 429": (r) => r.status === 429 });
}
