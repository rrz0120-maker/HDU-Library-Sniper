// The reference function is copied unchanged from AlaIchhe/HDU-Library-Sniper
// internal/hdu/crypto.go at 30d2a1937ff183a7f236e1b347ae7cddb1a21560 (MIT).
// Offline oracle only; this file cannot send requests or book seats.
package signatures

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func ApiToken(seatID, uid string, beginTime, duration, apiTime int64) string {
	src := fmt.Sprintf(
		"post&/Seat/Index/bookSeats?LAB_JSON=1&api_time%d&beginTime%d&duration%d&is_recommend0&seatBookers[0]%s&seats[0]%s",
		apiTime, beginTime, duration, uid, seatID,
	)
	sum := md5.Sum([]byte(src))
	hexStr := hex.EncodeToString(sum[:])
	return base64.StdEncoding.EncodeToString([]byte(hexStr))
}

func TestP53FourteenHourVectors(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	bytes, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "fixtures", "p53-signatures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		SeatID    string `json:"seatId"`
		UID       string `json:"uid"`
		BeginTime int64  `json:"beginTime"`
		Duration  int64  `json:"duration"`
		APITime   int64  `json:"apiTime"`
		Token     string `json:"token"`
	}
	if err := json.Unmarshal(bytes, &vectors); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		if v.Duration != 50400 || ApiToken(v.SeatID, v.UID, v.BeginTime, v.Duration, v.APITime) != v.Token {
			t.Fatalf("vector %d does not match original Go signing function", i)
		}
	}
}
