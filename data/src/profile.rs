//! A ship's tools, as Privateer's `ship.profile {ship}` returns them: its
//! model routes, charter, permissions, the skills and MCP servers of the
//! first mate's bounded plan, the plugins it loads, and how it sleeps.
//!
//! No secret value is kept. Privateer writes `"<set>"` for a set option
//! whose name looks secret; here such an option keeps only whether it is
//! set, and so does any option whose name looks secret. Nested values are
//! written out with every secret-looking key masked, and every URL loses its
//! user name and password and any secret-looking query value. An MCP
//! server's URL keeps only its scheme, host and port, and its credentials
//! are names.

use serde::Deserialize;
use serde_json::{Map, Value};
use url::Url;

use crate::privateer::Error;

/// What Privateer writes in place of a set secret.
pub const SET: &str = "<set>";

/// Words that mark a name as a secret's, as Privateer's own list.
const SECRET_WORDS: [&str; 8] = [
    "key", "token", "secret", "pass", "auth", "cred", "cookie", "session",
];

/// The route kinds, in the order they are shown.
const KINDS: [&str; 3] = ["first_mate", "crew", "errand"];

/// What `ship.profile` answered for a ship.
#[derive(Debug, Clone, PartialEq)]
pub enum Read {
    Profile(Box<Profile>),
    /// The ship runs on this other machine, where its tools are read.
    Elsewhere(String),
}

/// A ship's tools.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Profile {
    pub ship: String,
    pub machine: Option<String>,
    pub hosted: Option<bool>,
    pub sleep: Sleep,
    pub harness: Option<String>,
    /// The first mate's options, by name, with secrets masked.
    pub options: Vec<Opt>,
    /// Each kind's route list, first mate, crew and errands first.
    pub routes: Vec<Routes>,
    pub charter: Charter,
    pub fleet_mode: Option<String>,
    pub fleet_rules: Vec<String>,
    /// Whether skills and MCP servers are a bounded plan: without one, the
    /// first mate loads its own and none is listed.
    pub bounded: Option<bool>,
    /// Why the first mate's tool plan could not be built.
    pub bundles_error: Option<String>,
    pub skills: Vec<Tool>,
    pub mcp_servers: Vec<Server>,
    pub plugins: Vec<Tool>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Sleep {
    /// `after_idle`, `never` or `not_hosted`.
    pub policy: Option<String>,
    /// Only for `after_idle`; may be fractional.
    pub idle_minutes: Option<f64>,
}

/// A first-mate option as shown.
#[derive(Debug, Clone, PartialEq)]
pub struct Opt {
    pub name: String,
    pub value: Shown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Shown {
    /// A secret: only whether it is set.
    Secret {
        set: bool,
    },
    /// A value with nothing secret left in it.
    Value(String),
    NotSet,
}

/// Which list a kind of job takes its routes from, and the routes in the
/// order they are tried.
#[derive(Debug, Clone, PartialEq)]
pub struct Routes {
    pub kind: String,
    /// `ship`, `fleet` or `none`.
    pub list: Option<String>,
    pub names: Vec<Route>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Route {
    pub name: String,
    pub cost: Option<String>,
    pub tier: Option<u64>,
    pub uses: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Charter {
    pub actions: Vec<String>,
    pub active: Option<bool>,
}

/// A skill or plugin. A plugin's name may be a path.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Tool {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Server {
    pub name: String,
    /// Only `scheme://host[:port]`.
    pub url: Option<String>,
    pub description: Option<String>,
    /// The credentials' names, never their values.
    pub credentials: Vec<String>,
}

/// `ship.profile` as Privateer sends it. Every part is optional.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Raw {
    ship: String,
    machine: Option<String>,
    hosted: Option<bool>,
    sleep: Option<Sleep>,
    first_mate: Option<RawFirstMate>,
    routes: Map<String, Value>,
    charter: Option<Charter>,
    permissions: Option<RawPermissions>,
    tool_bundles: Option<RawBundles>,
    skills: Vec<Tool>,
    mcp_servers: Vec<RawServer>,
    plugins: Vec<Tool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawFirstMate {
    harness: Option<String>,
    options: Map<String, Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawPermissions {
    fleet_mode: Option<String>,
    fleet_rules: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawBundles {
    bounded: Option<bool>,
    error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawServer {
    name: String,
    url: Option<String>,
    description: Option<String>,
    credentials: Vec<Value>,
}

impl Profile {
    pub fn parse(value: Value) -> Result<Self, String> {
        let raw: Raw =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        let first_mate = raw.first_mate.unwrap_or_default();
        let permissions = raw.permissions.unwrap_or_default();
        let bundles = raw.tool_bundles.unwrap_or_default();
        Ok(Profile {
            ship: raw.ship,
            machine: raw.machine,
            hosted: raw.hosted,
            sleep: raw.sleep.unwrap_or_default(),
            harness: first_mate.harness,
            options: first_mate
                .options
                .iter()
                .map(|(name, value)| option(name, value))
                .collect(),
            routes: routes(&raw.routes),
            charter: raw.charter.unwrap_or_default(),
            fleet_mode: permissions.fleet_mode,
            fleet_rules: permissions.fleet_rules,
            bounded: bundles.bounded,
            bundles_error: bundles.error.filter(|e| !e.is_empty()),
            skills: named(raw.skills),
            mcp_servers: raw
                .mcp_servers
                .into_iter()
                .filter(|server| !server.name.is_empty())
                .map(|server| Server {
                    name: server.name,
                    url: server.url.as_deref().and_then(server_url),
                    description: server.description,
                    credentials: server
                        .credentials
                        .iter()
                        .filter_map(credential_name)
                        .collect(),
                })
                .collect(),
            plugins: named(raw.plugins),
        })
    }
}

/// What a `ship.profile` for `ship` came to: its tools, or the machine it
/// runs on when Privateer refuses it as another machine's. Privateer prints
/// that refusal as JSON on stderr and exits 1.
pub fn read(ship: &str, answer: Result<Value, Error>) -> Result<Read, Error> {
    match answer {
        Ok(value) => Profile::parse(value)
            .map(|profile| Read::Profile(Box::new(profile)))
            .map_err(|error| Error::Command {
                command: "ship.profile".into(),
                error: format!("unexpected answer: {error}"),
            }),
        Err(error) => match elsewhere(ship, &error.to_string()) {
            Some(machine) => Ok(Read::Elsewhere(machine)),
            None => Err(error),
        },
    }
}

/// The machine in "ship X is on machine M; ask there".
fn elsewhere(ship: &str, error: &str) -> Option<String> {
    let prefix = format!("ship {ship} is on machine ");
    let (_, rest) = error.split_once(&prefix)?;
    let (machine, _) = rest.split_once("; ask there")?;
    (!machine.is_empty()).then(|| machine.to_owned())
}

/// Whether a name marks its value as a secret.
pub fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|word| name.contains(word))
}

fn option(name: &str, raw: &Value) -> Opt {
    let value = scalar_text(raw);
    // A value Privateer masked is a secret even under a name not listed.
    let value = if secret_name(name) || raw.as_str() == Some(SET) {
        Shown::Secret {
            set: value.is_some_and(|value| !value.is_empty()),
        }
    } else {
        value.map_or(Shown::NotSet, Shown::Value)
    };
    Opt {
        name: name.to_owned(),
        value,
    }
}

/// A value as text. Lists and maps are written as JSON with every
/// secret-looking key masked and every URL scrubbed, at every depth.
fn scalar_text(raw: &Value) -> Option<String> {
    match raw {
        Value::Null => None,
        Value::String(text) => Some(display_url(text).unwrap_or(text.clone())),
        Value::Bool(_) | Value::Number(_) => Some(raw.to_string()),
        Value::Array(_) | Value::Object(_) => Some(scrubbed(raw).to_string()),
    }
}

fn scrubbed(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    let shown = if secret_name(key) {
                        Value::String(SET.to_owned())
                    } else {
                        scrubbed(value)
                    };
                    (key.clone(), shown)
                })
                .collect(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(scrubbed).collect())
        }
        Value::String(text) => {
            Value::String(display_url(text).unwrap_or(text.clone()))
        }
        other => other.clone(),
    }
}

/// A URL with no user name or password, and with every secret-looking
/// query or fragment value hidden. None when the text is not a URL.
pub fn display_url(text: &str) -> Option<String> {
    let mut url = Url::parse(text).ok()?;
    if url.cannot_be_a_base() {
        return None;
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    if let Some(query) = url.query().map(hide_pairs) {
        url.set_query(Some(&query));
    }
    if let Some(fragment) = url.fragment().map(hide_pairs) {
        url.set_fragment(Some(&fragment));
    }
    Some(url.to_string())
}

/// `a=1&token=x` with each secret-looking value written `hidden`.
fn hide_pairs(pairs: &str) -> String {
    pairs
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, value))
                if !value.is_empty() && secret_name(&decoded(key)) =>
            {
                format!("{key}=hidden")
            }
            _ => pair.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// A query key as written, `%5F` read as `_`.
fn decoded(key: &str) -> String {
    url::form_urlencoded::parse(key.as_bytes())
        .next()
        .map_or_else(|| key.to_owned(), |(key, _)| key.into_owned())
}

/// Only a server's scheme, host and port: which server it is.
pub fn server_url(text: &str) -> Option<String> {
    let url = Url::parse(text).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// A credential's name, from a name or `{name}`; never a value.
fn credential_name(value: &Value) -> Option<String> {
    let name = match value {
        Value::String(name) => name,
        Value::Object(fields) => fields.get("name")?.as_str()?,
        _ => return None,
    };
    (!name.is_empty()).then(|| name.to_owned())
}

fn named(tools: Vec<Tool>) -> Vec<Tool> {
    tools.into_iter().filter(|t| !t.name.is_empty()).collect()
}

/// The route lists by kind, with each route's cost, tier and uses from the
/// `routes` map beside them.
fn routes(raw: &Map<String, Value>) -> Vec<Routes> {
    let facts = raw.get("routes").and_then(Value::as_object);
    let mut kinds: Vec<&String> = raw
        .iter()
        .filter(|(_, value)| value.get("list").is_some())
        .map(|(kind, _)| kind)
        .collect();
    kinds.sort_by_key(|kind| {
        KINDS
            .iter()
            .position(|known| known == kind)
            .unwrap_or(KINDS.len())
    });
    kinds
        .into_iter()
        .map(|kind| {
            let lists = &raw[kind];
            let names = lists["names"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|name| {
                    let fact = facts.and_then(|facts| facts.get(name));
                    let field = |key| fact.and_then(|fact| fact.get(key));
                    Route {
                        name: name.to_owned(),
                        cost: field("cost")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        tier: field("tier").and_then(Value::as_u64),
                        uses: field("uses")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect(),
                    }
                })
                .collect();
            Routes {
                kind: kind.clone(),
                list: lists["list"].as_str().map(str::to_owned),
                names,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fixture(ship: &str) -> Value {
        let all: Value = serde_json::from_str(include_str!(
            "../../fixtures/ship.profile.json"
        ))
        .unwrap();
        all["ships"][ship].clone()
    }

    fn shown(profile: &Profile, name: &str) -> Shown {
        profile
            .options
            .iter()
            .find(|o| o.name == name)
            .unwrap()
            .value
            .clone()
    }

    /// Everything a profile would put on screen, as one text.
    fn everything(profile: &Profile) -> String {
        format!("{profile:?}")
    }

    #[test]
    fn reads_the_fixture_in_privateers_shape() {
        let billing = Profile::parse(fixture("billing")).unwrap();
        assert_eq!(billing.ship, "billing");
        assert_eq!(billing.machine.as_deref(), Some("atlas"));
        assert_eq!(billing.hosted, Some(true));
        assert_eq!(billing.sleep.policy.as_deref(), Some("after_idle"));
        assert_eq!(billing.sleep.idle_minutes, Some(30.0));
        assert_eq!(billing.harness.as_deref(), Some("pi"));
        let kinds: Vec<&str> =
            billing.routes.iter().map(|r| r.kind.as_str()).collect();
        assert_eq!(kinds, ["first_mate", "crew", "errand"]);
        assert_eq!(billing.routes[1].list.as_deref(), Some("ship"));
        let first_mate = &billing.routes[0];
        assert_eq!(first_mate.list.as_deref(), Some("fleet"));
        assert_eq!(first_mate.names[0].name, "plan-main");
        assert_eq!(first_mate.names[0].tier, Some(1));
        assert_eq!(first_mate.names[0].uses.len(), 4);
        assert_eq!(first_mate.names[1].cost.as_deref(), Some("free"));
        assert_eq!(billing.routes[2].names[1].tier, None);
        assert_eq!(billing.charter.actions.len(), 6);
        assert_eq!(billing.charter.active, Some(true));
        assert_eq!(billing.fleet_mode.as_deref(), Some("ask"));
        assert_eq!(billing.fleet_rules.len(), 2);
        assert_eq!(billing.bounded, Some(true));
        assert_eq!(billing.bundles_error, None);
        assert_eq!(billing.skills.len(), 11);
        assert_eq!(billing.mcp_servers.len(), 4);
        assert_eq!(billing.plugins[0].name, "attended/mail.ts");

        let chandlery = Profile::parse(fixture("chandlery")).unwrap();
        assert_eq!(chandlery.sleep.idle_minutes, Some(7.5));
        assert_eq!(chandlery.charter.active, Some(false));
        assert!(chandlery.bundles_error.unwrap().contains("catalogue-pages"));

        let docs = Profile::parse(fixture("docs-site")).unwrap();
        assert_eq!(docs.harness, None);
        assert_eq!(docs.bounded, Some(false));
        assert_eq!(docs.routes[2].list.as_deref(), Some("none"));
        assert!(docs.routes[2].names.is_empty());

        let status = Profile::parse(fixture("status-page")).unwrap();
        assert_eq!(status.sleep.policy.as_deref(), Some("not_hosted"));
        assert_eq!(status.sleep.idle_minutes, None);
    }

    #[test]
    fn tolerates_missing_and_extra_fields() {
        let sparse =
            Profile::parse(json!({"ship": "x", "something_new": 1})).unwrap();
        assert_eq!(sparse.ship, "x");
        assert!(sparse.routes.is_empty());
        assert!(sparse.options.is_empty());
        assert_eq!(sparse.bounded, None);

        let odd = Profile::parse(json!({
            "routes": {"crew": {"list": "ship", "names": ["a"], "extra": 1}},
            "skills": [{"name": ""}, {"name": "s", "extra": true}],
            "mcp_servers": [{"name": "m", "credentials": [{"name": "TOKEN"}, 3]}],
            "tool_bundles": {"bounded": true, "selected": ["b@1"], "error": null},
        }))
        .unwrap();
        assert_eq!(
            odd.routes[0].names[0],
            Route {
                name: "a".into(),
                ..Route::default()
            }
        );
        assert_eq!(odd.skills.len(), 1);
        assert_eq!(odd.mcp_servers[0].credentials, ["TOKEN"]);
        assert_eq!(odd.bundles_error, None);
    }

    #[test]
    fn a_set_secret_shows_only_that_it_is_set() {
        let profile = Profile::parse(json!({"first_mate": {"options": {
            "api_key": "<set>",
            // Masked by Privateer under a name this list does not know.
            "bearer": "<set>",
            "model": "large",
        }}}))
        .unwrap();
        assert_eq!(shown(&profile, "api_key"), Shown::Secret { set: true });
        assert_eq!(shown(&profile, "bearer"), Shown::Secret { set: true });
        assert_eq!(shown(&profile, "model"), Shown::Value("large".into()));
    }

    #[test]
    fn secret_names_show_set_or_not_set_and_never_a_value() {
        let profile = Profile::parse(json!({"first_mate": {"options": {
            "Session_ID": "s-PLANTED",
            "password": "PLANTED",
            "Auth": {"user": "PLANTED"},
            "cookie_jar": null,
            "credential": "",
            "access_token": 1234,
        }}}))
        .unwrap();
        assert_eq!(shown(&profile, "Session_ID"), Shown::Secret { set: true });
        assert_eq!(shown(&profile, "password"), Shown::Secret { set: true });
        assert_eq!(shown(&profile, "Auth"), Shown::Secret { set: true });
        assert_eq!(shown(&profile, "cookie_jar"), Shown::Secret { set: false });
        assert_eq!(shown(&profile, "credential"), Shown::Secret { set: false });
        assert_eq!(
            shown(&profile, "access_token"),
            Shown::Secret { set: true }
        );
        assert!(!everything(&profile).contains("PLANTED"));
        assert!(!everything(&profile).contains("1234"));
    }

    #[test]
    fn urls_lose_their_user_password_and_secret_query_values() {
        assert_eq!(
            display_url(
                "https://deck:hunter2@proxy.example.test:8443/v1?api_token=abc&region=eu#access_token=def"
            )
            .as_deref(),
            Some(
                "https://proxy.example.test:8443/v1?api_token=hidden&region=eu#access_token=hidden"
            )
        );
        assert_eq!(
            display_url("https://h.test/?api%5Fkey=abc").as_deref(),
            Some("https://h.test/?api%5Fkey=hidden")
        );
        assert_eq!(display_url("large"), None);
        assert_eq!(display_url("mailto:a@b.test"), None);

        let profile = Profile::parse(json!({"first_mate": {"options": {
            "proxy": "https://u:PLANTED@proxy.test/?Secret=PLANTED&ok=1",
        }}}))
        .unwrap();
        assert_eq!(
            shown(&profile, "proxy"),
            Shown::Value("https://proxy.test/?Secret=hidden&ok=1".into())
        );
    }

    #[test]
    fn nested_values_are_masked_and_scrubbed_at_every_depth() {
        let profile = Profile::parse(json!({"first_mate": {"options": {
            "upstream": {
                "region": "eu",
                "headers": {"X-Api-Key": "PLANTED-1", "Accept": "json"},
                "mirrors": [
                    {"url": "https://u:PLANTED-2@m.test/x?token=PLANTED-3"},
                    {"deep": [{"passphrase": "PLANTED-4"}]},
                ],
            },
            "list": ["https://a:PLANTED-5@b.test/", 7],
        }}}))
        .unwrap();
        let Shown::Value(upstream) = shown(&profile, "upstream") else {
            panic!("upstream is not a secret");
        };
        let upstream: Value = serde_json::from_str(&upstream).unwrap();
        assert_eq!(
            upstream,
            json!({
                "region": "eu",
                "headers": {"X-Api-Key": "<set>", "Accept": "json"},
                "mirrors": [
                    {"url": "https://m.test/x?token=hidden"},
                    {"deep": [{"passphrase": "<set>"}]},
                ],
            })
        );
        assert_eq!(
            shown(&profile, "list"),
            Shown::Value(r#"["https://b.test/",7]"#.into())
        );
        assert!(!everything(&profile).contains("PLANTED"));
    }

    #[test]
    fn mcp_servers_keep_scheme_host_and_port_and_credential_names() {
        let profile = Profile::parse(json!({"mcp_servers": [{
            "name": "docs",
            "url": "https://u:PLANTED@mcp.example.test:8443/s/PLANTED/mcp?key=PLANTED#PLANTED",
            "credentials": ["DOCS_TOKEN"],
        }]}))
        .unwrap();
        let server = &profile.mcp_servers[0];
        assert_eq!(
            server.url.as_deref(),
            Some("https://mcp.example.test:8443")
        );
        assert_eq!(server.credentials, ["DOCS_TOKEN"]);
        assert!(!everything(&profile).contains("PLANTED"));
    }

    #[test]
    fn the_fixtures_planted_secrets_never_survive() {
        let billing = Profile::parse(fixture("billing")).unwrap();
        assert!(!everything(&billing).contains("PLANTED"));
        assert_eq!(shown(&billing, "api_key"), Shown::Secret { set: true });
    }

    #[test]
    fn a_ship_on_another_machine_is_read_there_not_an_error() {
        let refusal = "ship search-index is on machine boreas; ask there";
        let on_stderr = Error::Exit {
            command: "ship.profile".into(),
            status: "exit status: 1".into(),
            stderr: json!({"ok": false, "error": refusal}).to_string(),
        };
        assert_eq!(
            read("search-index", Err(on_stderr)),
            Ok(Read::Elsewhere("boreas".into()))
        );
        let as_command = Error::Command {
            command: "ship.profile".into(),
            error: refusal.into(),
        };
        assert_eq!(
            read("search-index", Err(as_command)),
            Ok(Read::Elsewhere("boreas".into()))
        );

        let unknown = Error::Command {
            command: "ship.profile".into(),
            error: "unknown ship nowhere".into(),
        };
        assert_eq!(read("nowhere", Err(unknown.clone())), Err(unknown));
        // Another ship's refusal is not this one's.
        let other = Error::Command {
            command: "ship.profile".into(),
            error: refusal.into(),
        };
        assert!(read("billing", Err(other)).is_err());
    }
}
