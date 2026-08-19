// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"testing"

	"github.com/spf13/cobra"
)

func TestStorageCommandExposesMoveStatus(t *testing.T) {
	command, _, err := StorageCmd.Find([]string{"move-status"})
	if err != nil {
		t.Fatalf("find move-status command: %v", err)
	}
	if command == nil {
		t.Fatal("move-status command is not registered")
	}
	if command.Use != "move-status [SANDBOX_ID] [OPERATION_ID]" {
		t.Fatalf("move-status Use = %q", command.Use)
	}
}

func TestMoveStatusArgsRequireCanonicalUUIDs(t *testing.T) {
	command, _, err := StorageCmd.Find([]string{"move-status"})
	if err != nil || command == nil {
		t.Fatalf("find move-status command: %v", err)
	}

	valid := []string{
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
	}
	if err := command.Args(command, valid); err != nil {
		t.Fatalf("valid move-status args rejected: %v", err)
	}

	invalidCases := [][]string{
		{"not-a-uuid", valid[1]},
		{valid[0], "22222222-2222-4222-8222-222222222222/../x"},
		{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "extra"},
	}
	for _, args := range invalidCases {
		if err := command.Args(command, args); err == nil {
			t.Fatalf("invalid move-status args accepted: %v", args)
		}
	}
}

func TestStorageCommandUsesCobraCommandType(t *testing.T) {
	if _, ok := any(StorageCmd).(*cobra.Command); !ok {
		t.Fatal("storage command is not a Cobra command")
	}
}
