package airfields

import (
	"testing"
)

func TestParseCSVAndBuildTuples(t *testing.T) {
	rows, err := ParseCSV("a,b\n\"hello, world\",\"quoted \"\"value\"\"\"\n", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[1][0] != "hello, world" || rows[1][1] != `quoted "value"` {
		t.Fatalf("rows = %#v", rows)
	}
	airports := `ident,type,name,latitude_deg,longitude_deg,municipality,icao_code,iata_code
LARGE,large_airport,Large Airport,37.5,127.1,Seoul,KLAR,LAR
SMALL,small_airport,Small Airport,-89.9,-179.9,,,
`
	runways := `airport_ident,le_ident,he_ident,length_ft,closed
LARGE,01,19,10000,0
SMALL,,,1000,0
`
	dataset, err := BuildTuples(airports, runways)
	if err != nil {
		t.Fatal(err)
	}
	if dataset.Counts.Airports != 2 || dataset.Counts.Index != 1 ||
		dataset.Counts.Small != 1 || dataset.Counts.Runways != 2 {
		t.Fatalf("counts = %#v", dataset.Counts)
	}
	if len(dataset.Cells["0-0"]) != 1 {
		t.Fatalf("cells = %#v", dataset.Cells)
	}
}

func TestCellIDBounds(t *testing.T) {
	if CellID(-90, -180) != "0-0" || CellID(90, 180) != "17-35" {
		t.Fatalf("bounds = %s %s", CellID(-90, -180), CellID(90, 180))
	}
}
