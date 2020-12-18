---
title: Introduction
slug: /docs
---

Welcome to the Quirrel docs 🎉  

These pages aim to guide your usage of Quirrel and answer all questions you might have.
If there's anything missing or unclear, make sure to put it in the "Feedback" form that's accessible via the menu bar.

## Using the Docs

The Quirrel Docs are divided into three main sections:

- *Getting Started* (on the sidebar) is the entrypoint for new Quirrel users. It guides you through setting up your first queue and explains how Quirrel works.
- *API* (reachable via the menu bar) is for development. It talks about the meaning of all the different Quirrel parameters.
- *Deploying* (on the sidebar) is for when your project goes live. It guides you through making the right settings with your hosting provider.

Additionally, there's [How Quirrel Works](docs/how-quirrel-works) if you want to get an understanding of the system and an [FAQ](docs/faq) for all things that don't fall into one of the other categories.

## Wtf is "Quirrel"?

If you've been brought here by some link and haven't heard about Quirrel before:  
Quirrel is a job queueing service designed specifically for serverless environments.

Possible use-cases for Quirrel include:
- delaying some task for more than a second
- distributing task batches across lambdas to speed up execution
- sending your users a "how was your first week?" email one week after signup
- fetching some data on a (cron) schedule

Quirrel currently has support for Next.js and Blitz.js, with integrations for other frameworks coming in the future.

