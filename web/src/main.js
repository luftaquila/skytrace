import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

document.documentElement.dataset.skytraceVersion = __SKYTRACE_WEB_VERSION__;
createApp(App).mount("#app");
