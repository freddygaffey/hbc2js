-- tests/projdb/sample/make-sample.sql — A1's hand-written sample project
-- (docs/specs/16-project-db.md §7 A1): meta, 3 functions, 5 calls incl. one
-- '?', 2 revisions + log. Applied after src/projdb/schema.sql, in-memory,
-- by tests/projdb/schema.test.ts.

INSERT INTO meta (key, value) VALUES
  ('schema', 'hbc2js-proj/1'),
  ('created_at', '2026-09-03T00:00:00.000Z'),
  ('bundle_sha256', 'deadbeef'),
  ('function_count', '3');

INSERT INTO ix_functions (fn, name, params, module, parent, kind, offset, size) VALUES
  (1, 'root', 0, 0, NULL, 'global', 0, 100),
  (2, 'helper', 1, 0, 1, 'named', 100, 40),
  (3, 'anon', 0, 0, 1, 'anonymous', 140, 20);

-- Inserted out of caller/site order deliberately, so A1e's sortedness
-- assertion on v_json_calls is a real check, not an insertion-order echo.
INSERT INTO ix_calls (caller, site, callee, kind, via, why) VALUES
  (2, 2, 'b:bar', 'builtin', NULL, NULL),
  (1, 1, '2', 'direct', NULL, NULL),
  (3, 1, '?', 'unknown', NULL, 'indirect call target unresolved'),
  (1, 2, 'g:foo', 'global', NULL, NULL),
  (2, 1, 'm:5', 'module', NULL, NULL);

INSERT INTO revisions (rid, kind, target, slot, prov_source, prov_who, prov_run,
                        ts, supersedes, reactivates, cleared, ctx_name, ctx_loc, ctx_owner,
                        legacy_rid) VALUES
  (1, 'name', 'fn:2', 'name:fn:2', 'human', 'fred', NULL,
   '2026-09-03T00:00:01.000Z', NULL, NULL, 0, NULL, NULL, NULL, NULL),
  (2, 'tag', 'fn:3', 'tag:fn:3:reviewed', 'llm', 'run7', 'run7',
   '2026-09-03T00:00:02.000Z', NULL, NULL, 0, 'anon', 'index.js:140', 'root', NULL);

INSERT INTO d_names (rid, name) VALUES (1, 'decodePayload');
INSERT INTO d_tags  (rid, tag, note) VALUES (2, 'reviewed', 'looked fine');

INSERT INTO log (seq, ts, actor_source, actor_who, actor_run, op, rid, gen, detail) VALUES
  (1, '2026-09-03T00:00:00.000Z', 'tool', 'init', NULL, 'init', NULL, NULL, '{}'),
  (2, '2026-09-03T00:00:01.000Z', 'human', 'fred', NULL, 'annotate', 1, NULL, '{"kind":"name"}'),
  (3, '2026-09-03T00:00:02.000Z', 'llm', 'run7', 'run7', 'annotate', 2, NULL, '{"kind":"tag"}');
