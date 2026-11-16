import { ORIGIN } from "./core.js";
import { Engine } from "./engine.js";
import { Ledger } from "./ledger.js";
import { Transport } from "./transport.js";
import { mount } from "./panel.js";
if (location.origin === ORIGIN && window.top === window.self && !document.getElementById("hdu-p51-panel"))
  mount(new Engine(new Transport(), new Ledger()));
