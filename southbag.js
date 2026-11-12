/*
 * southbag.js — the script applied across all Southbag sites.
 *
 * One tag gives a page the shared house behaviour:
 *
 *   <script src="https://cdn.jsdelivr.net/gh/southbag-agent/southbag.js@main/southbag.js"
 *           data-app="banking"
 *           data-session-url="/api/session"
 *           data-user-id="…" data-user-email="…" data-user-name="…"></script>
 *
 * What it does:
 *
 *   1. Kevin is always written "Kevin". Prose typed into a plain text field or
 *      contenteditable region is corrected as it is typed ("kevin", "KEVIN",
 *      "kEvIn" → "Kevin"), keeping the caret where it was and the native undo
 *      stack intact (each correction is its own undoable edit). Identifier
 *      fields (email, URL and search inputs) are never touched, and "kevin"
 *      inside an identifier — an email address, URL, query string or handle —
 *      is left alone too ("kevin@x.com", "x.com/kevin", "?q=kevin", "@kevin").
 *      Password and other non-text fields, read-only/disabled fields, code
 *      editors, unfinished IME input, and anything inside
 *      [data-southbag-no-kevin] are left alone. A word the caret still sits on
 *      is corrected on the next keystroke, on Tab/Enter, or when the pointer
 *      leaves the field — always while the field is still focused, so the
 *      native undo stack survives; undo and redo are never re-corrected. On
 *      engines too old for execCommand("insertText") the correction simply
 *      doesn't run — text is never rewritten behind the undo stack's back.
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
 *   3. Shared namespace: `window.southbag` ({ version, kevin.fix, palantir }).
 *
 * Opt out of either piece on the script tag: data-no-kevin, data-no-analytics.
 * The same flags can be set before load on `window.southbagConfig`
 * ({ noKevin, noAnalytics, app, sessionUrl, userId, userEmail, userName }).
 */
(function () {
	"use strict";

	var VERSION = "0.2.2";
	var script = document.currentScript;
	var ds = (script && script.dataset) || {};
	var config = window.southbagConfig || {};

	function opt(name) {
		return ds[name] !== undefined ? ds[name] : config[name];
	}
	var fixing = false; // re-entrancy guard for our own undo-preserving edits

	function disabled(attrName, cfgName) {
		if (script && script.hasAttribute && script.hasAttribute(attrName)) return true;
		return !!config[cfgName];
	}

	if (window.southbag && window.southbag.version) return; // already loaded

	/* ------------------------------------------------------------------ *
	 * 1. Kevin is always written "Kevin".                                 *
	 * ------------------------------------------------------------------ */

	// "kevin" as its own word, any capitals — but never inside an identifier.
	// A match touching a word character (letters, digits, _) or one of
	// @ . / ? # = & % ~ : + is part of an email address, URL, query string,
	// handle or other machine-readable token, and is left exactly as typed:
	// "dear kevin," → "dear Kevin," but "kevin@x.com", "x.com/kevin",
	// "?q=kevin", "@kevin" and "kevins_stapler" are untouched. The
	// replacement is always the same length, so caret offsets survive unchanged.
	// Neighbours that always mark an identifier: word chars plus @ / ? # = & % ~ +
	var NOT_PROSE = /[A-Za-z0-9_@\/?#=&%~+]/;
	var WORD = /[A-Za-z0-9_]/;
	// "." and ":" count only when they actually join two identifier pieces, so
	// sentence punctuation still fixes: "dear kevin." → "dear Kevin." and
	// "kevin: hello" → "Kevin: hello", but "example.kevin" and "user:kevin" stay.
	function isProseKevin(whole, offset, length) {
		var before = whole.charAt(offset - 1);
		var after = whole.charAt(offset + length);
		if (before) {
			if (NOT_PROSE.test(before)) return false;
			if ((before === "." || before === ":") && WORD.test(whole.charAt(offset - 2))) return false;
		}
		if (after) {
			if (NOT_PROSE.test(after)) return false;
			if ((after === "." || after === ":") && WORD.test(whole.charAt(offset + length + 1))) return false;
		}
		return true;
	}
	function fixKevin(text) {
		return String(text).replace(/kevin/gi, function (match, offset, whole) {
			return isProseKevin(whole, offset, match.length) ? "Kevin" : match;
		});
	}
	// Offsets of every "kevin" that fixKevin would change, for undo-preserving edits.
	function kevinEdits(text) {
		var edits = [];
		String(text).replace(/kevin/gi, function (match, offset, whole) {
			if (isProseKevin(whole, offset, match.length) && match !== "Kevin")
				edits.push([offset, offset + match.length]);
			return match;
		});
		return edits;
	}

	// Plain prose fields only. Passwords, hidden, numbers, dates, files and friends
	// are never touched — and neither are email, URL or search inputs, whose whole
	// value is an identifier rather than prose. Code editors and explicit opt-outs
	// are skipped via selector.
	var TEXT_TYPES = ["", "text", "tel"];
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

	// Corrections go through execCommand("insertText"): each one lands as a real,
	// undoable edit on the native undo stack. Engines without it get no correction
	// at all — leaving the text exactly as typed beats rewriting it behind the
	// undo stack's back.
	// aggressive: also fix the word the caret sits on (Tab/Enter, pointer-away).
	// While typing, a match touching the caret is left alone — the next keystroke
	// may turn it into an identifier ("kevin" + "@" = an email local part).
	function fixField(el, aggressive) {
		if (document.activeElement !== el) return; // never write to an unfocused field
		if (typeof document.execCommand !== "function") return; // no safe write path
		var edits = kevinEdits(el.value);
		if (!edits.length) return;
		var start = null, end = null;
		try {
			start = el.selectionStart;
			end = el.selectionEnd;
		} catch (e) {}
		if (!aggressive && start != null)
			edits = edits.filter(function (r) {
				return start < r[0] || start > r[1];
			});
		if (!edits.length) return;
		fixing = true;
		try {
			for (var i = 0; i < edits.length; i++) {
				el.setSelectionRange(edits[i][0], edits[i][1]);
				if (!document.execCommand("insertText", false, "Kevin")) break;
			}
		} catch (e) {}
		fixing = false;
		try {
			if (start != null) el.setSelectionRange(start, end);
		} catch (e) {}
	}

	function fixRich(root, aggressive) {
		var selection = (document.getSelection && document.getSelection()) || null;
		var anchor = null, focus = null;
		try {
			if (selection && selection.anchorNode && root.contains(selection.anchorNode))
				anchor = [selection.anchorNode, selection.anchorOffset];
			if (selection && selection.focusNode && root.contains(selection.focusNode))
				focus = [selection.focusNode, selection.focusOffset];
		} catch (e) {}
		// Undo-preserving path: while the selection is inside the region, select each
		// "kevin" and replace it with execCommand so it joins the native undo stack.
		// One match per pass — the DOM shifts under us as edits land.
		var active = document.activeElement;
		var engaged =
			(anchor && true) || active === root || (active && root.contains(active));
		if (!engaged) return; // never write to a region the user has left
		// No execCommand, no correction: an eager node rewrite would destroy the
		// region's undo history, which is worse than leaving "kevin" as typed.
		if (typeof document.execCommand !== "function") return;
		if (selection && anchor) {
			fixing = true;
			try {
				for (var guard = 0; guard < 100; guard++) {
					var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
					var focusNode = selection.focusNode,
						focusOffset = selection.focusOffset;
					var node,
						hit = null;
					while ((node = walker.nextNode())) {
						var edits = kevinEdits(node.nodeValue || "");
						if (!aggressive && node === focusNode)
							edits = edits.filter(function (r) {
								return focusOffset < r[0] || focusOffset > r[1];
							});
						if (edits.length) {
							hit = [node, edits[0][0], edits[0][1]];
							break;
						}
					}
					if (!hit) break;
					var range = document.createRange();
					range.setStart(hit[0], hit[1]);
					range.setEnd(hit[0], hit[2]);
					selection.removeAllRanges();
					selection.addRange(range);
					if (!document.execCommand("insertText", false, "Kevin")) break;
				}
			} catch (e) {}
			fixing = false;
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
				if (fixing || composing || e.isComposing) return;
				// Undo/redo are the user reasserting their own text — never re-correct.
				if (e.inputType === "historyUndo" || e.inputType === "historyRedo") return;
				var target = kevinTarget(e.target);
				if (!target) return;
				if (target.kind === "field") fixField(target.el);
				else fixRich(target.el);
			},
			true
		);
		// Tab/Enter announce "the word is finished" while the field still has focus,
		// so the trailing word can be fixed undo-preservingly before the blur lands.
		document.addEventListener(
			"keydown",
			function (e) {
				if (e.key !== "Tab" && e.key !== "Enter") return;
				var target = kevinTarget(e.target);
				if (!target) return;
				if (target.kind === "field") fixField(target.el, true);
				else fixRich(target.el, true);
			},
			true
		);
		// Clicking or tapping elsewhere: pointerdown lands before the focus move.
		// Fixing now, while the region is still focused, keeps undo intact.
		document.addEventListener(
			"pointerdown",
			function (e) {
				var active = document.activeElement;
				if (!active || (e.target && (e.target === active || active.contains(e.target)))) return;
				var target = kevinTarget(active);
				if (!target) return;
				if (target.kind === "field") fixField(target.el, true);
				else fixRich(target.el, true);
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
				// Not aggressive on purpose: the committed word still sits under the
				// caret and could grow into an identifier. The next keystroke, or
				// Tab/Enter/leaving the field, fixes it.
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

})();
