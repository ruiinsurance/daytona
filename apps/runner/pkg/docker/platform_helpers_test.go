// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"os"
	"runtime"
	"testing"
)

func TestFileChangeTimeUsesPlatformContract(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "change-time")
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(file.Name())
	if err != nil {
		t.Fatal(err)
	}

	changedAt, ok := fileChangeTime(info)
	if runtime.GOOS == "linux" {
		if !ok || changedAt.IsZero() {
			t.Fatalf("fileChangeTime() = (%v, %t), want a Linux ctime", changedAt, ok)
		}
		return
	}

	if ok || !changedAt.IsZero() {
		t.Fatalf("fileChangeTime() = (%v, %t), want an unsupported-platform fallback", changedAt, ok)
	}
}
