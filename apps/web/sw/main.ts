/**
 * The service worker's entry, built into dist/sw.js by plugin.ts, which puts this build's name and
 * files in place of INKLOG_BUILD.
 */
import { type Build, serve } from './service-worker';

declare const self: ServiceWorkerGlobalScope;
declare const INKLOG_BUILD: Build;

serve(self, INKLOG_BUILD);
