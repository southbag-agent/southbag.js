/*
 * southbag.js — the script applied across all Southbag sites.
 *
 * One tag gives a page the shared house behaviour:
 *
 *   <script src="https://cdn.jsdelivr.net/gh/SouthbagHQ/southbag.js@main/southbag.js"
 *           data-app="banking"
 *           data-session-url="/api/session"
 *           data-user-id="…" data-user-email="…" data-user-name="…"></script>
 *
 * What it does:
 *
 *   1. Kevin is always written "Kevin". Anything typed into a text field or
 *      contenteditable region is corrected as it is typed ("kevin", "KEVIN",
 *      "kEvIn" → "Kevin"), keeping the caret where it was. Password and other
 *      non-text fields, read-only/disabled fields, code editors, unfinished
 *      IME input, and anything inside [data-southbag-no-kevin] are left alone.
 *
 *   2. Palantir — Southbag's PostHog wiring (moved here from the per-app
 *      palantir.js copies). Same script-tag options as before:
 *        data-app          Name of the app (super property `southbag_app`).
 *        data-user-*       The signed-in user as the server knows them. Identifies immediately.
 *        data-session-url  Same-origin JSON endpoint returning `{ user: { id, email, name } }`
 *                          (or `{ authenticated: false }`) — used when the page has no data-user-*.
 *      When neither yields a user, Southbag Identity is asked directly: its session cookie
 *      lives on `.southbag.cc`, so every Southbag app can resolve it with `credentials: "include"`.
 *      Custom events: `window.palantir.capture("event_name", { … })` — unchanged.
 *
 *   3. Shared extras: `window.southbag` ({ version, kevin.fix, palantir }) and a
 *      console banner. Kevin is watching.
 *
 * Opt out of any piece on the script tag: data-no-kevin, data-no-analytics, data-no-banner.
 * The same flags can be set before load on `window.southbagConfig`
 * ({ noKevin, noAnalytics, noBanner, app, sessionUrl, userId, userEmail, userName }).
 */
(function () {
	"use strict";

	var VERSION = "0.1.0";
	var script = document.currentScript;
	var ds = (script && script.dataset) || {};
	var config = window.southbagConfig || {};

	function opt(name) {
		return ds[name] !== undefined ? ds[name] : config[name];
	}
	function disabled(attrName, cfgName) {
		if (script && script.hasAttribute && script.hasAttribute(attrName)) return true;
		return !!config[cfgName];
	}

	if (window.southbag && window.southbag.version) return; // already loaded

	/* ------------------------------------------------------------------ *
	 * 1. Kevin is always written "Kevin".                                 *
	 * ------------------------------------------------------------------ */

	// Whole word, any capitals ("kevin", "KEVIN", "kEvIn" → "Kevin"; "@kevin" → "@Kevin").
	// Bounded on both sides, so "kevins_stapler" and "skevin" are left alone. The
	// replacement is always the same length, so caret offsets survive unchanged.
	var anyKevin = /\bkevin\b/gi;
	function fixKevin(text) {
		return String(text).replace(anyKevin, "Kevin");
	}

	// Text-like input types only. Passwords, hidden, numbers, dates, files and friends
	// are never touched. Code editors and explicit opt-outs are skipped via selector.
	var TEXT_TYPES = ["", "text", "search", "email", "url", "tel"];
	var SKIP_SELECTOR = "[data-southbag-no-kevin], .cm-content, .monaco-editor, .ace_editor";

	function kevinTarget(el) {
		if (!el || el.nodeType !== 1) return null;
		if (el.closest && el.closest(SKIP_SELECTOR)) return null;
		if (el instanceof HTMLInputElement) {
			if (TEXT_TYPES.indexOf(el.type) === -1 || el.readOnly || el.disabled) return null;
			return { kind: "field", el: el };
		}
		if (el instanceof HTMLTextAreaElement) {
			if (el.readOnly || el.disabled) return null;
			return { kind: "field", el: el };
		}
		var ce = el.closest ? el.closest("[contenteditable]") : null;
		if (ce) {
			var attr = ce.getAttribute("contenteditable");
			if (ce.isContentEditable || (attr !== null && attr !== "false")) return { kind: "rich", el: ce };
		}
		return null;
	}

	function fixField(el) {
		var fixed = fixKevin(el.value);
		if (fixed === el.value) return;
		var start = null, end = null;
		try {
			start = el.selectionStart;
			end = el.selectionEnd;
		} catch (e) {}
		el.value = fixed;
		try {
			if (start != null) el.setSelectionRange(start, end);
		} catch (e) {}
	}

	function fixRich(root) {
		var selection = (document.getSelection && document.getSelection()) || null;
		var anchor = null, focus = null;
		try {
			if (selection && selection.anchorNode && root.contains(selection.anchorNode))
				anchor = [selection.anchorNode, selection.anchorOffset];
			if (selection && selection.focusNode && root.contains(selection.focusNode))
				focus = [selection.focusNode, selection.focusOffset];
		} catch (e) {}
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		var node;
		while ((node = walker.nextNode())) {
			var value = fixKevin(node.nodeValue || "");
			if (value !== node.nodeValue) node.nodeValue = value;
		}
		try {
			if (anchor && focus && selection && selection.setBaseAndExtent)
				selection.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
		} catch (e) {}
	}

	function startKevin() {
		var composing = false;

		// Capture phase: the value is corrected before app and framework handlers read it,
		// so controlled inputs (Svelte, React, Vue) pick up "Kevin" without a second event.
		document.addEventListener(
			"input",
			function (e) {
				if (composing || e.isComposing) return;
				var target = kevinTarget(e.target);
				if (!target) return;
				if (target.kind === "field") fixField(target.el);
				else fixRich(target.el);
			},
			true
		);
		document.addEventListener(
			"compositionstart",
			function (e) {
				if (kevinTarget(e.target)) composing = true;
			},
			true
		);
		document.addEventListener(
			"compositionend",
			function (e) {
				composing = false;
				var target = kevinTarget(e.target);
				if (!target) return;
				if (target.kind === "field") fixField(target.el);
				else fixRich(target.el);
			},
			true
		);
	}

	/* ------------------------------------------------------------------ *
	 * 2. Palantir — Southbag's PostHog wiring.                            *
	 *    Moved here from the palantir.js copies vendored into every app.  *
	 * ------------------------------------------------------------------ */

	function startPalantir() {
		var IDENTITY = "https://identity.southbag.cc";

		// If a vendored palantir.js already initialised PostHog on this page, keep its
		// instance and only fill in the API surface.
		if (window.posthog && (window.posthog.__loaded || window.posthog.__SV)) {
			if (!window.palantir) {
				window.palantir = {
					capture: function (event, properties) {
						window.posthog.capture(event, properties);
					},
					identify: function (user) {
						if (user && user.id) window.posthog.identify(String(user.id));
					},
					reset: function () {
						window.posthog.reset();
					},
				};
			}
			return;
		}

		// PostHog's loader stub (array.js). Queues calls until the real library loads.
		!(function (t, e) {
			var o, n, p, r;
			e.__SV ||
				(window.posthog && window.posthog.__loaded) ||
				((window.posthog = e),
				(e._i = []),
				(e.init = function (i, s, a) {
					function g(t, e) {
						var o = e.split(".");
						2 == o.length && ((t = t[o[0]]), (e = o[1])),
							(t[e] = function () {
								t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
							});
					}
					((p = t.createElement("script")).type = "text/javascript"),
						(p.crossOrigin = "anonymous"),
						(p.async = !0),
						(p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js"),
						(r = t.getElementsByTagName("script")[0]) ? r.parentNode.insertBefore(p, r) : (t.head || t.documentElement).appendChild(p);
					var u = e;
					for (void 0 !== a ? (u = e[a] = []) : (a = "posthog"), u.people = u.people || [], u.toString = function (t) {
						var e = "posthog";
						return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e;
					}, u.people.toString = function () {
						return u.toString(1) + ".people (stub)";
					}, o = "ki Ci init qi Hi pr ji zi Di capture calculateEventProperties Qi register register_once register_for_session unregister unregister_for_session Ki getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Xi identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty Ji Gi createPersonProfile setInternalOrTestUser Yi Ai rn opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing Vi debug mr it getPageViewId captureTraceFeedback captureTraceMetric Oi".split(" "), n = 0; n < o.length; n++)
						g(u, o[n]);
					e._i.push([i, s, a]);
				}),
				(e.__SV = 1));
		})(document, window.posthog || []);

		function identify(user) {
			if (!user || !user.id) return;
			var props = {};
			if (user.email) props.email = user.email;
			if (user.name) props.name = user.name;
			window.posthog.identify(String(user.id), props);
		}

		function resetIfIdentified() {
			if (window.posthog.get_property("$user_state") === "identified") window.posthog.reset();
		}

		function sessionUser(url, credentials) {
			return fetch(url, { credentials: credentials, headers: { accept: "application/json" } })
				.then(function (response) {
					if (!response.ok) return undefined;
					return response.json();
				})
				.then(function (body) {
					if (body === undefined) return undefined; // couldn't ask — say nothing
					return body && body.user && body.user.id ? body.user : null; // null = confirmed signed out
				})
				.catch(function () {
					return undefined;
				});
		}

		function resolveUser() {
			var userId = opt("userId");
			if (userId) {
				identify({ id: userId, email: opt("userEmail"), name: opt("userName") });
				return;
			}
			var sessionUrl = opt("sessionUrl");
			var local = sessionUrl ? sessionUser(sessionUrl, "same-origin") : Promise.resolve(null);
			local
				.then(function (user) {
					if (user) return user;
					return sessionUser(IDENTITY + "/api/auth/get-session", "include");
				})
				.then(function (user) {
					if (user) identify(user);
					else if (user === null) resetIfIdentified();
				});
		}

		window.posthog.init("phc_rStyYsw4wrB8MwXEsPBJjz57uipHycNVwFPaw2m3aYXo", {
			api_host: "https://palantir.southbag.cc",
			ui_host: "https://us.posthog.com",
			defaults: "2026-05-30",
			person_profiles: "always",
			cross_subdomain_cookie: true,
			persistence: "localStorage+cookie",
			capture_pageview: "history_change",
			capture_pageleave: true,
			autocapture: true,
			capture_heatmaps: true,
			capture_dead_clicks: true,
			capture_exceptions: true,
			capture_performance: { network_timing: true, web_vitals: true },
			rageclick: true,
			enable_recording_console_log: true,
			disable_session_recording: false,
			session_recording: {
				maskAllInputs: false,
				maskTextSelector: null,
				recordCrossOriginIframes: true,
				recordHeaders: true,
				recordBody: true,
				recordCanvas: true,
			},
			loaded: function (ph) {
				ph.register({ southbag_app: opt("app") || location.hostname });
				resolveUser();
			},
		});

		window.palantir = {
			capture: function (event, properties) {
				window.posthog.capture(event, properties);
			},
			identify: identify,
			reset: function () {
				window.posthog.reset();
			},
		};
	}

	/* ------------------------------------------------------------------ */

	if (!disabled("data-no-kevin", "noKevin")) startKevin();
	if (!disabled("data-no-analytics", "noAnalytics")) startPalantir();

	window.southbag = {
		version: VERSION,
		kevin: { fix: fixKevin },
		palantir: window.palantir,
	};

	if (!disabled("data-no-banner", "noBanner") && window.console && console.log) {
		console.log(
			"%cSouthbag.js v" + VERSION + "%c — Kevin is watching.",
			"font-weight: bold",
			"font-weight: normal"
		);
	}
})();
