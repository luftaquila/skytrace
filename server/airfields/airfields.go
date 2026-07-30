package airfields

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAirportsURL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
	defaultRunwaysURL  = "https://davidmegginson.github.io/ourairports-data/runways.csv"
	cellSizeDegrees    = 10
	formatVersion      = 1

	maxAirportRows   = 100000
	maxRunwayRows    = 250000
	maxCSVColumns    = 64
	maxCSVFieldChars = 4096
	maxAirports      = 75000
	maxIndex         = 15000
	maxRunways       = 100000
	maxCells         = 648
	maxCellFields    = 10000
	maxPayloadBytes  = 16 * 1024 * 1024
	maxVersionBytes  = 64 * 1024 * 1024
	maxStoreBytes    = 256 * 1024 * 1024
	maxSourceBytes   = 64 * 1024 * 1024
	minAirports      = 40000
	minIndex         = 4000
	minRunways       = 20000
	relativeFloor    = 0.9
	versionRetention = 60 * 24 * time.Hour
)

type Counts struct {
	Airports int `json:"airports"`
	Index    int `json:"index"`
	Small    int `json:"small"`
	Runways  int `json:"runways"`
	Cells    int `json:"cells"`
}

type SourceState struct {
	ETag         *string `json:"etag"`
	LastModified *string `json:"lastModified"`
}

type ManifestSource struct {
	Airports SourceState `json:"airports"`
	Runways  SourceState `json:"runways"`
}

type Manifest struct {
	Format          int            `json:"format"`
	Version         string         `json:"version"`
	PreviousVersion *string        `json:"previousVersion"`
	GeneratedAt     string         `json:"generatedAt"`
	CheckedAt       string         `json:"checkedAt"`
	Source          ManifestSource `json:"source"`
	Counts          Counts         `json:"counts"`
	CellSizeDeg     int            `json:"cellSizeDeg"`
	Cells           map[string]int `json:"cells"`
}

type Dataset struct {
	Index  [][]any
	Cells  map[string][][]any
	Counts Counts
}

func ParseCSV(text string, maxRows int) ([][]string, error) {
	reader := csv.NewReader(strings.NewReader(text))
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = false
	rows := [][]string{}
	for {
		row, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(row) > maxCSVColumns {
			return nil, errors.New("CSV row exceeds the configured column limit")
		}
		for index := range row {
			row[index] = strings.TrimSuffix(row[index], "\r")
			if len([]rune(row[index])) > maxCSVFieldChars {
				return nil, errors.New("CSV field exceeds the configured limit")
			}
		}
		if len(row) == 1 && row[0] == "" {
			continue
		}
		rows = append(rows, row)
		if len(rows) > maxRows {
			return nil, errors.New("CSV exceeds the configured row limit")
		}
	}
	return rows, nil
}

func CellID(lat, lon float64) string {
	latIndex := max(0, min(17, int(math.Floor((lat+90)/cellSizeDegrees))))
	lonIndex := max(0, min(35, int(math.Floor((lon+180)/cellSizeDegrees))))
	return fmt.Sprintf("%d-%d", latIndex, lonIndex)
}

func BuildTuples(airportsCSV, runwaysCSV string) (Dataset, error) {
	airportRows, err := ParseCSV(airportsCSV, maxAirportRows)
	if err != nil {
		return Dataset{}, err
	}
	runwayRows, err := ParseCSV(runwaysCSV, maxRunwayRows)
	if err != nil {
		return Dataset{}, err
	}
	if len(airportRows) < 2 || len(runwayRows) < 2 {
		return Dataset{}, errors.New("empty source dataset")
	}
	airportHeader := headerMap(airportRows[0])
	runwayHeader := headerMap(runwayRows[0])
	for _, column := range []string{"ident", "type", "latitude_deg", "longitude_deg", "name"} {
		if _, ok := airportHeader[column]; !ok {
			return Dataset{}, fmt.Errorf("airports.csv is missing the %s column", column)
		}
	}
	for _, column := range []string{"airport_ident", "le_ident", "he_ident", "length_ft", "closed"} {
		if _, ok := runwayHeader[column]; !ok {
			return Dataset{}, fmt.Errorf("runways.csv is missing the %s column", column)
		}
	}

	runwaysByAirport := make(map[string][][]any)
	runwayCount := 0
	for _, row := range runwayRows[1:] {
		if len(row) < len(runwayRows[0]) || field(row, runwayHeader, "closed") == "1" {
			continue
		}
		ident := field(row, runwayHeader, "airport_ident")
		if ident == "" {
			continue
		}
		ends := strings.Join(nonempty(
			field(row, runwayHeader, "le_ident"),
			field(row, runwayHeader, "he_ident"),
		), "/")
		var endsValue any
		if ends != "" {
			endsValue = ends
		}
		var lengthValue any
		if feet, err := strconv.ParseFloat(field(row, runwayHeader, "length_ft"), 64); err == nil {
			lengthValue = int64(math.Floor(feet*0.3048 + 0.5))
		}
		if endsValue == nil && lengthValue == nil {
			continue
		}
		runwaysByAirport[ident] = append(runwaysByAirport[ident], []any{endsValue, lengthValue})
		runwayCount++
	}

	index := [][]any{}
	cells := make(map[string][][]any)
	for _, row := range airportRows[1:] {
		if len(row) < len(airportRows[0]) {
			continue
		}
		airportType := field(row, airportHeader, "type")
		if airportType != "large_airport" && airportType != "medium_airport" && airportType != "small_airport" {
			continue
		}
		lat, latErr := strconv.ParseFloat(field(row, airportHeader, "latitude_deg"), 64)
		lon, lonErr := strconv.ParseFloat(field(row, airportHeader, "longitude_deg"), 64)
		if latErr != nil || lonErr != nil || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			continue
		}
		ident := field(row, airportHeader, "ident")
		icao := nullable(field(row, airportHeader, "icao_code"))
		iata := nullable(field(row, airportHeader, "iata_code"))
		code := ident
		if iata != nil {
			code = iata.(string)
		} else if icao != nil {
			code = icao.(string)
		}
		runways := runwaysByAirport[ident]
		if runways == nil {
			runways = [][]any{}
		}
		sort.SliceStable(runways, func(i, j int) bool {
			iLength := int64(-1)
			jLength := int64(-1)
			if runways[i][1] != nil {
				iLength = runways[i][1].(int64)
			}
			if runways[j][1] != nil {
				jLength = runways[j][1].(int64)
			}
			if iLength != jLength {
				return iLength > jLength
			}
			return fmt.Sprint(runways[i][0]) < fmt.Sprint(runways[j][0])
		})
		kind := strings.TrimSuffix(airportType, "_airport")
		tuple := []any{
			code,
			icao,
			iata,
			field(row, airportHeader, "name"),
			kind[:1],
			nullable(field(row, airportHeader, "municipality")),
			round(lat, 5),
			round(lon, 5),
			runways,
		}
		if kind == "small" {
			id := CellID(lat, lon)
			cells[id] = append(cells[id], tuple)
		} else {
			index = append(index, tuple)
		}
	}
	byCode := func(values [][]any) {
		sort.SliceStable(values, func(i, j int) bool {
			return fmt.Sprint(values[i][0]) < fmt.Sprint(values[j][0])
		})
	}
	byCode(index)
	small := 0
	for _, values := range cells {
		byCode(values)
		small += len(values)
	}
	return Dataset{
		Index: index,
		Cells: cells,
		Counts: Counts{
			Airports: len(index) + small,
			Index:    len(index),
			Small:    small,
			Runways:  runwayCount,
			Cells:    len(cells),
		},
	}, nil
}

func headerMap(row []string) map[string]int {
	result := make(map[string]int, len(row))
	for index, value := range row {
		result[value] = index
	}
	return result
}

func field(row []string, header map[string]int, name string) string {
	index, ok := header[name]
	if !ok || index >= len(row) {
		return ""
	}
	return row[index]
}

func nonempty(values ...string) []string {
	result := []string{}
	for _, value := range values {
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func round(value float64, digits int) float64 {
	scale := math.Pow10(digits)
	return math.Floor(value*scale+0.5) / scale
}

func validateCounts(counts Counts, current *Counts) error {
	switch {
	case counts.Airports < minAirports:
		return errors.New("airport dataset is incomplete")
	case counts.Index < minIndex:
		return errors.New("airport index is incomplete")
	case counts.Runways < minRunways:
		return errors.New("runway dataset is incomplete")
	case counts.Airports > maxAirports:
		return errors.New("airport dataset exceeds the configured limit")
	case counts.Index > maxIndex:
		return errors.New("airport index exceeds the configured limit")
	case counts.Runways > maxRunways:
		return errors.New("runway dataset exceeds the configured limit")
	case counts.Cells > maxCells:
		return errors.New("airport cell count exceeds the configured limit")
	}
	if current != nil {
		for _, pair := range [][2]int{
			{counts.Airports, current.Airports},
			{counts.Index, current.Index},
			{counts.Small, current.Small},
			{counts.Runways, current.Runways},
		} {
			if float64(pair[0]) < float64(pair[1])*relativeFloor {
				return errors.New("airport dataset regressed")
			}
		}
	}
	return nil
}

func datasetVersion(now time.Time, airports, runways string) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte(airports))
	_, _ = hash.Write([]byte(runways))
	return now.UTC().Format("20060102") + "-" + hex.EncodeToString(hash.Sum(nil))[:10]
}

func writePayload(dir, name string, value any, budget *int64) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(encoded) > maxPayloadBytes {
		return fmt.Errorf("%s exceeds the configured payload limit", name)
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(encoded); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	if compressed.Len() > maxPayloadBytes {
		return fmt.Errorf("%s.gz exceeds the configured payload limit", name)
	}
	*budget += int64(len(encoded) + compressed.Len())
	if *budget > maxVersionBytes {
		return errors.New("airfield version exceeds the configured byte limit")
	}
	if err := os.WriteFile(filepath.Join(dir, name), encoded, 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+".gz"), compressed.Bytes(), 0o600)
}
