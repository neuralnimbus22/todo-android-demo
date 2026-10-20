/*
 * Copyright (C) 2022 The Android Open Source Project
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
package com.example.android.architecture.blueprints.todoapp

import androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.Companion.APPLICATION_KEY
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.example.android.architecture.blueprints.todoapp.addedittask.AddEditTaskViewModel
import com.example.android.architecture.blueprints.todoapp.statistics.StatisticsViewModel
import com.example.android.architecture.blueprints.todoapp.taskdetail.TaskDetailViewModel
import com.example.android.architecture.blueprints.todoapp.tasks.TasksViewModel

/**
 * Global factory for all ViewModels in the application.
 *
 * This factory utilizes [CreationExtras] to resolve required dependencies
 * (such as TaskRepository and SavedStateHandle).
 */
val TodoViewModelFactory = viewModelFactory {
    initializer<StatisticsViewModel> {
        StatisticsViewModel(application.taskRepository)
    }
    initializer<TaskDetailViewModel> {
        TaskDetailViewModel(application.taskRepository)
    }
    initializer<AddEditTaskViewModel> {
        AddEditTaskViewModel(application.taskRepository)
    }
    initializer<TasksViewModel> {
        TasksViewModel(application.taskRepository, createSavedStateHandle())
    }
}

/**
 * Extension property to extract the [TodoApplication] instance from [CreationExtras].
 *
 * @throws IllegalStateException if the application is missing or is the wrong type.
 */
private val CreationExtras.application: TodoApplication
    get() = this[APPLICATION_KEY] as? TodoApplication
        ?: error("`APPLICATION_KEY` in `CreationExtras` is missing or not a `TodoApplication`.")
