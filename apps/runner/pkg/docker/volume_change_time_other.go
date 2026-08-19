//go:build !linux

// Copyright Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"os"
	"time"
)

func fileChangeTime(_ os.FileInfo) (time.Time, bool) {
	return time.Time{}, false
}
