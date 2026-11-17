#pragma once
#include <windows.h>

typedef struct {
    HANDLE job;
    HANDLE marker;
    wchar_t path[32768];
} QuarterdeckLaunchCustody;

int quarterdeck_private_handle(HANDLE file);
int quarterdeck_launches_drained(const wchar_t *lock);
int quarterdeck_begin_launch(const wchar_t *lock, QuarterdeckLaunchCustody *custody);
int quarterdeck_end_launch(QuarterdeckLaunchCustody *custody);
