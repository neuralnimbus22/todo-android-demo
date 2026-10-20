/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.example.android.architecture.blueprints.todoapp.util

/**
 * Runs [assertion] until it passes or [timeoutMillis] runs out, then rethrows the last
 * failure. Use it for checks that wait on an animation, such as the pull-to-refresh spinner.
 */
fun eventually(timeoutMillis: Long = 3_000, assertion: () -> Unit) {
    val deadline = System.currentTimeMillis() + timeoutMillis
    while (true) {
        try {
            assertion()
            return
        } catch (failure: Throwable) {
            if (System.currentTimeMillis() >= deadline) throw failure
            Thread.sleep(100)
        }
    }
}
