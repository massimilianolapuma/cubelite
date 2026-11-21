//! The environment of a kubeconfig context (#662): Development, Test, Staging
//! or Production, read from the words of the context name.
//!
//! A context name is split into words on every character that is not an
//! ASCII letter or digit. A word matches a variant when, ignoring case, it
//! equals the variant or the variant followed only by digits (`prod01`,
//! `svil2`). The first matching word, left to right, decides. Only the
//! context name is read: not the cluster, the server or the namespace.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

/// The environment a context belongs to.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    /// Development (`dev`, `svil`, …).
    Development,
    /// Test (`test`, `qa`, …).
    Test,
    /// Staging, collaudo, UAT and pre-production.
    Staging,
    /// Production.
    Production,
}

impl Environment {
    /// Every environment, in the order the app shows them.
    pub const ALL: [Environment; 4] = [
        Environment::Development,
        Environment::Test,
        Environment::Staging,
        Environment::Production,
    ];

    /// The name shown to the user: `Development`, `Test`, `Staging`, `Production`.
    pub fn label(self) -> &'static str {
        match self {
            Environment::Development => "Development",
            Environment::Test => "Test",
            Environment::Staging => "Staging",
            Environment::Production => "Production",
        }
    }

    /// The environment written as `text` in the settings file (`production`),
    /// or `None` for a value this version does not know.
    pub fn parse(text: &str) -> Option<Environment> {
        match text {
            "development" => Some(Environment::Development),
            "test" => Some(Environment::Test),
            "staging" => Some(Environment::Staging),
            "production" => Some(Environment::Production),
            _ => None,
        }
    }
}

impl fmt::Display for Environment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// The words that name each environment in a context name.
///
/// Read leniently: a key this version does not know (an environment added by
/// a newer version) is ignored rather than failing the whole settings file.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct Variants(pub BTreeMap<Environment, Vec<String>>);

impl<'de> Deserialize<'de> for Variants {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = BTreeMap::<String, Vec<String>>::deserialize(deserializer)?;
        Ok(Variants(
            raw.into_iter()
                .filter_map(|(key, words)| Environment::parse(&key).map(|env| (env, words)))
                .collect(),
        ))
    }
}

impl Default for Variants {
    fn default() -> Self {
        let words = |list: &[&str]| list.iter().map(|w| (*w).to_string()).collect::<Vec<_>>();
        Variants(BTreeMap::from([
            (
                Environment::Development,
                words(&["dev", "develop", "development", "svil", "sviluppo"]),
            ),
            (Environment::Test, words(&["test", "tst", "qa"])),
            (
                Environment::Staging,
                words(&[
                    "stg", "stage", "staging", "coll", "collaudo", "uat", "preprod",
                ]),
            ),
            (
                Environment::Production,
                words(&["prod", "prd", "production", "produzione"]),
            ),
        ]))
    }
}

impl Variants {
    /// The variants of one environment (empty when none).
    pub fn of(&self, environment: Environment) -> &[String] {
        self.0.get(&environment).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// Why a set of variants was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VariantsError {
    /// A word holds something other than letters and digits, or no letter at all.
    #[error("\"{word}\" is not a single word")]
    InvalidWord {
        /// The environment whose list holds the word.
        environment: Environment,
        /// The word, trimmed and lowercased.
        word: String,
    },
    /// The same word names two environments.
    #[error("\"{word}\" is already in {first}")]
    Duplicate {
        /// The word, trimmed and lowercased.
        word: String,
        /// The environment that lists it first.
        first: Environment,
        /// The environment that lists it again.
        second: Environment,
    },
}

/// The environment `context_name` names, if any of its words matches a variant.
pub fn detect(context_name: &str, variants: &Variants) -> Option<Environment> {
    context_name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| word.bytes().any(|b| b.is_ascii_alphabetic()))
        .find_map(|word| {
            let word = word.to_ascii_lowercase();
            Environment::ALL.into_iter().find(|env| {
                variants
                    .of(*env)
                    .iter()
                    .any(|variant| word_matches(&word, variant))
            })
        })
}

/// Whether `word` (lowercase) is `variant` or `variant` followed only by digits.
fn word_matches(word: &str, variant: &str) -> bool {
    let variant = variant.to_ascii_lowercase();
    !variant.is_empty()
        && word
            .strip_prefix(variant.as_str())
            .is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_digit()))
}

/// `input` made usable by [`detect`]: each word trimmed and lowercased, empty
/// words dropped, every environment present. A word with a character outside
/// `[a-z0-9]`, or with no letter, and a word listed in two environments are
/// refused.
pub fn validate_variants(input: &Variants) -> Result<Variants, VariantsError> {
    let mut seen: BTreeMap<String, Environment> = BTreeMap::new();
    let mut out = BTreeMap::new();
    for environment in Environment::ALL {
        let mut words: Vec<String> = Vec::new();
        for raw in input.of(environment) {
            let word = raw.trim().to_lowercase();
            if word.is_empty() {
                continue;
            }
            let single = word.bytes().all(|b| b.is_ascii_alphanumeric())
                && word.bytes().any(|b| b.is_ascii_alphabetic());
            if !single {
                return Err(VariantsError::InvalidWord { environment, word });
            }
            match seen.get(&word) {
                Some(first) if *first != environment => {
                    return Err(VariantsError::Duplicate {
                        word,
                        first: *first,
                        second: environment,
                    });
                }
                Some(_) => continue,
                None => {
                    seen.insert(word.clone(), environment);
                    words.push(word);
                }
            }
        }
        out.insert(environment, words);
    }
    Ok(Variants(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(name: &str) -> Option<Environment> {
        detect(name, &Variants::default())
    }

    use Environment::{Development, Production, Staging, Test};

    #[test]
    fn detects_user_contexts() {
        assert_eq!(d("aks-prod-01-emm"), Some(Production));
        assert_eq!(d("aks-test-01-emm"), Some(Test));
        assert_eq!(d("aks-svil-01-emm"), Some(Development));
        assert_eq!(d("kub3-dev"), Some(Development));
        assert_eq!(d("dol-lab-aks"), None);
        assert_eq!(d("minikube"), None);
    }

    #[test]
    fn every_default_variant_detects_its_environment() {
        let variants = Variants::default();
        for env in Environment::ALL {
            assert!(!variants.of(env).is_empty(), "{env} has variants");
            for variant in variants.of(env) {
                let name = format!("x-{variant}-y");
                assert_eq!(detect(&name, &variants), Some(env), "{name}");
            }
        }
    }

    #[test]
    fn case_and_digits() {
        assert_eq!(d("PROD"), Some(Production));
        assert_eq!(d("Prod01"), Some(Production));
        assert_eq!(d("svil2"), Some(Development));
        assert_eq!(d("PROD-01"), Some(Production));
        assert_eq!(d("prod01a"), None);
        assert_eq!(d("prodx"), None);
        assert_eq!(d("production2b"), None);
    }

    #[test]
    fn whole_words_only() {
        assert_eq!(d("preprod-eu"), Some(Staging));
        assert_eq!(d("devops-tools"), None);
        assert_eq!(d("my.prod.cluster"), Some(Production));
        assert_eq!(d("user@prd"), Some(Production));
        assert_eq!(d("a:qa/b c"), Some(Test));
        assert_eq!(d("team_uat"), Some(Staging));
    }

    #[test]
    fn first_word_wins() {
        assert_eq!(d("dev-to-prod"), Some(Development));
        assert_eq!(d("prod-mirror-of-dev"), Some(Production));
    }

    #[test]
    fn degenerate_names() {
        assert_eq!(d(""), None);
        assert_eq!(d("01"), None);
        assert_eq!(d("---"), None);
        assert_eq!(d("prod-"), Some(Production));
        assert_eq!(d("é-prod"), Some(Production));
        assert_eq!(d("prodé"), Some(Production));
    }

    #[test]
    fn detection_reads_custom_variants() {
        let variants = Variants(BTreeMap::from([(Production, vec!["live".to_string()])]));
        assert_eq!(detect("eu-live2", &variants), Some(Production));
        assert_eq!(detect("eu-prod", &variants), None);
    }

    #[test]
    fn validate_normalises_and_rejects() {
        let input = Variants(BTreeMap::from([
            (
                Production,
                vec![" Prod ".to_string(), String::new(), "  ".to_string()],
            ),
            (Test, vec!["QA".to_string()]),
        ]));
        let valid = validate_variants(&input).expect("valid");
        assert_eq!(valid.of(Production), ["prod".to_string()]);
        assert_eq!(valid.of(Test), ["qa".to_string()]);
        assert!(valid.of(Development).is_empty());
        assert!(
            valid.0.contains_key(&Development),
            "every environment present"
        );
        assert!(valid.0.contains_key(&Staging), "every environment present");

        let dashed = Variants(BTreeMap::from([(Staging, vec!["pre-prod".to_string()])]));
        assert_eq!(
            validate_variants(&dashed),
            Err(VariantsError::InvalidWord {
                environment: Staging,
                word: "pre-prod".to_string()
            })
        );
        let spaced = Variants(BTreeMap::from([(Staging, vec!["pre prod".to_string()])]));
        assert!(matches!(
            validate_variants(&spaced),
            Err(VariantsError::InvalidWord { .. })
        ));
        let digits = Variants(BTreeMap::from([(Staging, vec!["01".to_string()])]));
        assert!(matches!(
            validate_variants(&digits),
            Err(VariantsError::InvalidWord { .. })
        ));

        let twice = Variants(BTreeMap::from([
            (Test, vec!["prod".to_string()]),
            (Production, vec!["PROD".to_string()]),
        ]));
        assert_eq!(
            validate_variants(&twice),
            Err(VariantsError::Duplicate {
                word: "prod".to_string(),
                first: Test,
                second: Production
            })
        );

        let repeated = Variants(BTreeMap::from([(
            Production,
            vec!["prod".to_string(), "Prod".to_string()],
        )]));
        assert_eq!(
            validate_variants(&repeated)
                .expect("same list")
                .of(Production),
            ["prod".to_string()]
        );
    }

    #[test]
    fn validation_error_text() {
        let dup = VariantsError::Duplicate {
            word: "prod".to_string(),
            first: Production,
            second: Test,
        };
        assert_eq!(dup.to_string(), "\"prod\" is already in Production");
        let bad = VariantsError::InvalidWord {
            environment: Staging,
            word: "pre-prod".to_string(),
        };
        assert_eq!(bad.to_string(), "\"pre-prod\" is not a single word");
    }

    #[test]
    fn variants_ignore_unknown_environments() {
        let read: Variants =
            serde_json::from_str(r#"{"production":["prod"],"sandbox":["sbx"]}"#).expect("parse");
        assert_eq!(read.of(Production), ["prod".to_string()]);
        assert_eq!(read.0.len(), 1);
        let written = serde_json::to_string(&Variants::default()).expect("write");
        assert!(written.starts_with(r#"{"development":["dev""#), "{written}");
    }
}
