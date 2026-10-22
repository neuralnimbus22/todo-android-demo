# Android to-do sample for AI test selection in Testkube

This repository is a copy of the [Android Architecture Blueprints](https://github.com/android/architecture-samples) to-do app, `views` branch, commit `32cd12f`, under the Apache License 2.0. It is used to show test selection with Testkube on a mobile app: for each change, Testkube works out which Espresso test classes the change reaches, an AI agent decides which of them to run, and Testkube runs only those on an Android emulator inside a Kubernetes cluster.

## How it works

1. A push to a `demo/` branch starts the `selected-espresso-tests` job in CircleCI, defined in `.circleci/config.yml`. The job starts the `android-test-selection` workflow in Testkube for that branch and waits for the result.
2. `android-test-selection` lists the changed files and runs `testkube/tracer/trace-android.mjs`, taken from `main`. The script follows the change through Kotlin code, layouts, navigation graphs and resources to the screens it reaches, labels every instrumented test class, and saves `impact.json` with the diff. No AI runs in this step.
3. When that run passes, the AI Agent Trigger `android-test-selection-trigger` starts the `android-test-selector` agent. The agent reads `impact.json` and the diff, decides every test class with a reason, and starts `espresso-ui-selected` with only the picked classes.
4. `espresso-ui-selected` builds the app, boots an Android 11 emulator in the cluster, and runs the picked classes with `connectedMockDebugAndroidTest`. JUnit results, the HTML report and logcat are saved with the run.
5. The CircleCI job follows that run and passes or fails with it. It prints the agent's decisions and stores the JUnit results and the Android test report, so failing tests show in CircleCI's Tests tab. If the agent picks nothing, the job passes without an emulator run.

The CircleCI job needs a `TESTKUBE_API_KEY` environment variable in the CircleCI project settings: a Testkube API token with Run access to the environment. `.github/workflows/test-selection.yml` starts the same flow from GitHub Actions, by hand only, and does not wait for the result.

The Testkube workflows, the trace script, the CI script and the agent settings are in [`testkube/`](testkube/).

## Changes from the original

- The original GitHub workflows are removed. `.circleci/config.yml` and a manual `.github/workflows/test-selection.yml` are added.
- Pull-to-refresh tests are added to `TaskDetailFragmentTest` and `StatisticsFragmentTest`, with a small `eventually` helper in `sharedTest`.
- `testkube/` is added.

The original README follows.

---

# Android Architecture Blueprints v2
<p align="center">
<img src="https://github.com/googlesamples/android-architecture/wiki/images/aab-logov2.png" alt="Illustration by Virginia Poltrack"/>
</p>

Android Architecture Blueprints is a project to showcase different architectural approaches to developing Android apps. In its different branches you'll find the same app (a TODO app) implemented with small differences.

In this branch you'll find:
*   Kotlin **[Coroutines](https://kotlinlang.org/docs/reference/coroutines-overview.html)** for background operations.
*   A single-activity architecture, using the **[Navigation component](https://developer.android.com/guide/navigation/navigation-getting-started)** to manage fragment operations.
*   A presentation layer that contains a fragment (View) and a **ViewModel** per screen (or feature).
*   Reactive UIs using **LiveData** observables and **Data Binding**.
*   A **data layer** with a repository and two data sources (local using Room and remote) that are queried with one-shot operations (no listeners or data streams).
*   Two **product flavors**, `mock` and `prod`, [to ease development and testing](https://android-developers.googleblog.com/2015/12/leveraging-product-flavors-in-android.html) (except in the Dagger branch).
*   A collection of unit, integration and e2e **tests**, including "shared" tests that can be run on emulator/device or Robolectric.

## Variations

This project hosts each sample app in separate repository branches. For more information, see the `README.md` file in each branch.

### Stable samples - Kotlin
|     Sample     | Description |
| ------------- | ------------- |
| [master](https://github.com/googlesamples/android-architecture/tree/master) | The base for the rest of the branches. <br/>Uses Kotlin, Architecture Components, coroutines, Data Binding, etc. and uses Room as source of truth, with a reactive UI. |
| [dagger-android](https://github.com/googlesamples/android-architecture/tree/dagger-android)<br/>[[compare](https://github.com/googlesamples/android-architecture/compare/dagger-android#files_bucket)] | A simple Dagger setup that uses `dagger-android` and removes the two flavors. |
| [usecases](https://github.com/googlesamples/android-architecture/tree/usecases)<br/>[[compare](https://github.com/googlesamples/android-architecture/compare/usecases#files_bucket)] | Adds a new domain layer that uses UseCases for business logic. |

### Old samples - Kotlin and Java

Blueprints v1 had a collection of samples that are not maintained anymore, but can still be useful. See [all project branches](https://github.com/googlesamples/android-architecture/branches).

## Why a to-do app?

<img align="right" src="https://github.com/googlesamples/android-architecture/wiki/images/todoapp.gif" alt="A demo illustraating the UI of the app" width="288" height="512" style="display: inline; float: right"/>

The app in this project aims to be simple enough that you can understand it quickly, but complex enough to showcase difficult design decisions and testing scenarios. For more information, see the [app's specification](https://github.com/googlesamples/android-architecture/wiki/To-do-app-specification).

## What is it not?

*   A UI/Material Design sample. The interface of the app is deliberately kept simple to focus on architecture. Check out [Plaid](https://github.com/android/plaid) instead.
*   A complete Jetpack sample covering all libraries. Check out [Android Sunflower](https://github.com/googlesamples/android-sunflower) or the advanced [Github Browser Sample](https://github.com/googlesamples/android-architecture-components/tree/master/GithubBrowserSample) instead.
*   A real production app with network access, user authentication, etc. Check out the [Google I/O app](https://github.com/google/iosched), [Santa Tracker](https://github.com/google/santa-tracker-android) or [Tivi](https://github.com/chrisbanes/tivi) for that.

## Who is it for?

*   Intermediate developers and beginners looking for a way to structure their app in a testable and maintainable way.
*   Advanced developers looking for quick reference.

## Opening a sample in Android Studio

To open one of the samples in Android Studio, begin by checking out one of the sample branches, and then open the root directory in Android Studio. The following series of steps illustrate how to open the [usecases](tree/usecases/) sample.

Clone the repository:

```
git clone git@github.com:googlesamples/android-architecture.git
```
This step checks out the master branch. If you want to change to a different sample: 

```
git checkout usecases
```

**Note:** To review a different sample, replace `usecases` with the name of sample you want to check out.

Finally open the `android-architecture/` directory in Android Studio.

### License


```
Copyright 2019 Google, Inc.

Licensed to the Apache Software Foundation (ASF) under one or more contributor
license agreements. See the NOTICE file distributed with this work for
additional information regarding copyright ownership. The ASF licenses this
file to you under the Apache License, Version 2.0 (the "License"); you may not
use this file except in compliance with the License. You may obtain a copy of
the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations under
the License.
```
