//! Client for tmux control mode.
//!
//! [`protocol`] is a pure, synchronous parser of the line protocol (testable
//! over recorded fixtures); [`client`] spawns `tmux -C` and exposes it as an
//! async command channel plus a stream of [`Notification`]s.

pub mod client;
pub mod protocol;

pub use client::{Client, Config, Error, Event, Mode, Reply};
pub use protocol::{unescape, Block, Message, Notification, Parser};
