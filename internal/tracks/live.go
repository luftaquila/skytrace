package tracks

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strings"
	"time"
)

type Aircraft struct {
	Hex            string   `json:"hex"`
	Flight         *string  `json:"flight"`
	Lat            *float64 `json:"lat"`
	Lon            *float64 `json:"lon"`
	AltBaro        *int64   `json:"altBaro"`
	AltGeom        *int64   `json:"altGeom"`
	OnGround       bool     `json:"onGround"`
	GS             *float64 `json:"gs"`
	IAS            *float64 `json:"ias"`
	TAS            *float64 `json:"tas"`
	Mach           *float64 `json:"mach"`
	Track          *float64 `json:"track"`
	TrueHeading    *float64 `json:"trueHeading"`
	MagHeading     *float64 `json:"magHeading"`
	BaroRate       *int64   `json:"baroRate"`
	GeomRate       *int64   `json:"geomRate"`
	TrackRate      *int64   `json:"trackRate"`
	Roll           *float64 `json:"roll"`
	Squawk         *string  `json:"squawk"`
	Category       *string  `json:"category"`
	SourceType     *string  `json:"sourceType"`
	SourceKind     *string  `json:"sourceKind"`
	Emergency      *string  `json:"emergency"`
	NavQNH         *float64 `json:"navQnh"`
	NavAltitudeMCP *int64   `json:"navAltitudeMcp"`
	NavAltitudeFMS *int64   `json:"navAltitudeFms"`
	NavHeading     *float64 `json:"navHeading"`
	WindDirection  *float64 `json:"windDirection"`
	WindSpeed      *float64 `json:"windSpeed"`
	OAT            *float64 `json:"oat"`
	TAT            *float64 `json:"tat"`
	NACP           *int64   `json:"nacP"`
	NACV           *int64   `json:"nacV"`
	NIC            *int64   `json:"nic"`
	NICBaro        *int64   `json:"nicBaro"`
	RC             *int64   `json:"rc"`
	SIL            *int64   `json:"sil"`
	SILType        *string  `json:"silType"`
	Version        *int64   `json:"version"`
	Alert          *int64   `json:"alert"`
	SPI            *int64   `json:"spi"`
	NonICAO        bool     `json:"nonIcao"`
	Messages       *int64   `json:"messages"`
	RSSI           *float64 `json:"rssi"`
	ObservedAt     string   `json:"observedAt"`
	PositionAt     *string  `json:"positionAt"`
	ReceiverCount  int      `json:"receiverCount"`
	BestReceiverID string   `json:"bestReceiverId"`
	Receivers      []string `json:"receivers"`
}

type Summary struct {
	WithPosition int            `json:"withPosition"`
	OnGround     int            `json:"onGround"`
	NonICAO      int            `json:"nonIcao"`
	Sources      map[string]int `json:"sources"`
}

type Current struct {
	Now      string     `json:"now"`
	Cutoff   string     `json:"cutoff"`
	Count    int        `json:"count"`
	Summary  Summary    `json:"summary"`
	Aircraft []Aircraft `json:"aircraft"`
}

type PublicReceiver struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Online          bool     `json:"online"`
	LastSeenAt      *string  `json:"lastSeenAt"`
	TotalIngests    int64    `json:"totalIngests"`
	CurrentAircraft int64    `json:"currentAircraft"`
	Lat             *float64 `json:"lat"`
	Lon             *float64 `json:"lon"`
}

type currentRow struct {
	ReceiverID     string
	Hex            string
	ObservedAt     string
	PositionAt     sql.NullString
	Lat            sql.NullFloat64
	Lon            sql.NullFloat64
	Flight         sql.NullString
	AltBaro        sql.NullFloat64
	AltGeom        sql.NullFloat64
	OnGround       int64
	GS             sql.NullFloat64
	IAS            sql.NullFloat64
	TAS            sql.NullFloat64
	Mach           sql.NullFloat64
	Track          sql.NullFloat64
	TrueHeading    sql.NullFloat64
	MagHeading     sql.NullFloat64
	BaroRate       sql.NullFloat64
	GeomRate       sql.NullFloat64
	TrackRate      sql.NullFloat64
	Roll           sql.NullFloat64
	Squawk         sql.NullString
	Category       sql.NullString
	SourceType     sql.NullString
	SourceKind     sql.NullString
	Emergency      sql.NullString
	NavQNH         sql.NullFloat64
	NavAltitudeMCP sql.NullFloat64
	NavAltitudeFMS sql.NullFloat64
	NavHeading     sql.NullFloat64
	WindDirection  sql.NullFloat64
	WindSpeed      sql.NullFloat64
	OAT            sql.NullFloat64
	TAT            sql.NullFloat64
	NACP           sql.NullInt64
	NACV           sql.NullInt64
	NIC            sql.NullInt64
	NICBaro        sql.NullInt64
	RC             sql.NullInt64
	SIL            sql.NullInt64
	SILType        sql.NullString
	Version        sql.NullInt64
	Alert          sql.NullInt64
	SPI            sql.NullInt64
	NonICAO        int64
	Messages       sql.NullInt64
	RSSI           sql.NullFloat64
}

func CurrentAircraft(ctx context.Context, db *sql.DB, now time.Time, window time.Duration) (Current, error) {
	nowText := iso(now)
	cutoff := iso(now.Add(-window))
	rows, err := db.QueryContext(ctx, `
		SELECT
		  c.receiver_id, c.hex, c.observed_at, c.position_at, c.lat, c.lon,
		  c.flight, c.alt_baro, c.alt_geom, c.on_ground, c.gs, c.ias, c.tas,
		  c.mach, c.track, c.true_heading, c.mag_heading, c.baro_rate,
		  c.geom_rate, c.track_rate, c.roll, c.squawk, c.category,
		  c.source_type, c.source_kind, c.emergency, c.nav_qnh,
		  c.nav_altitude_mcp, c.nav_altitude_fms, c.nav_heading, c.wd, c.ws,
		  c.oat, c.tat, c.nac_p, c.nac_v, c.nic, c.nic_baro, c.rc, c.sil,
		  c.sil_type, c.version, c.alert, c.spi, c.non_icao, c.messages, c.rssi
		FROM receiver_aircraft_current c
		WHERE c.observed_at >= ?
		ORDER BY c.hex, c.observed_at DESC
	`, cutoff)
	if err != nil {
		return Current{}, err
	}
	defer rows.Close()
	groups := make(map[string][]currentRow)
	for rows.Next() {
		var row currentRow
		if err := scanCurrentRow(rows, &row); err != nil {
			return Current{}, err
		}
		if !row.PositionAt.Valid || row.PositionAt.String < cutoff || row.PositionAt.String > nowText {
			row.PositionAt = sql.NullString{}
			row.Lat = sql.NullFloat64{}
			row.Lon = sql.NullFloat64{}
		}
		groups[row.Hex] = append(groups[row.Hex], row)
	}
	if err := rows.Err(); err != nil {
		return Current{}, err
	}

	result := Current{
		Now:    nowText,
		Cutoff: cutoff,
		Summary: Summary{
			Sources: make(map[string]int),
		},
		Aircraft: []Aircraft{},
	}
	for hex, group := range groups {
		sort.SliceStable(group, func(i, j int) bool {
			iPosition := group[i].Lat.Valid && group[i].Lon.Valid
			jPosition := group[j].Lat.Valid && group[j].Lon.Valid
			if iPosition != jPosition {
				return iPosition
			}
			iTime := group[i].ObservedAt
			if group[i].PositionAt.Valid {
				iTime = group[i].PositionAt.String
			}
			jTime := group[j].ObservedAt
			if group[j].PositionAt.Valid {
				jTime = group[j].PositionAt.String
			}
			return iTime > jTime
		})
		best := group[0]
		receiverSet := make(map[string]struct{}, len(group))
		for _, row := range group {
			receiverSet[row.ReceiverID] = struct{}{}
		}
		receivers := make([]string, 0, len(receiverSet))
		for receiver := range receiverSet {
			receivers = append(receivers, receiver)
		}
		sort.Strings(receivers)
		aircraft := Aircraft{
			Hex:            hex,
			Flight:         stringPointer(best.Flight),
			Lat:            roundedFloat(best.Lat, 5),
			Lon:            roundedFloat(best.Lon, 5),
			AltBaro:        roundedInteger(best.AltBaro),
			AltGeom:        roundedInteger(best.AltGeom),
			OnGround:       best.OnGround != 0,
			GS:             roundedFloat(best.GS, 1),
			IAS:            roundedFloat(best.IAS, 1),
			TAS:            roundedFloat(best.TAS, 1),
			Mach:           roundedFloat(best.Mach, 3),
			Track:          roundedFloat(best.Track, 1),
			TrueHeading:    roundedFloat(best.TrueHeading, 1),
			MagHeading:     roundedFloat(best.MagHeading, 1),
			BaroRate:       roundedInteger(best.BaroRate),
			GeomRate:       roundedInteger(best.GeomRate),
			TrackRate:      roundedInteger(best.TrackRate),
			Roll:           roundedFloat(best.Roll, 1),
			Squawk:         stringPointer(best.Squawk),
			Category:       stringPointer(best.Category),
			SourceType:     stringPointer(best.SourceType),
			SourceKind:     stringPointer(best.SourceKind),
			Emergency:      stringPointer(best.Emergency),
			NavQNH:         roundedFloat(best.NavQNH, 1),
			NavAltitudeMCP: roundedInteger(best.NavAltitudeMCP),
			NavAltitudeFMS: roundedInteger(best.NavAltitudeFMS),
			NavHeading:     roundedFloat(best.NavHeading, 1),
			WindDirection:  roundedFloat(best.WindDirection, 1),
			WindSpeed:      roundedFloat(best.WindSpeed, 1),
			OAT:            roundedFloat(best.OAT, 1),
			TAT:            roundedFloat(best.TAT, 1),
			NACP:           intPointer(best.NACP),
			NACV:           intPointer(best.NACV),
			NIC:            intPointer(best.NIC),
			NICBaro:        intPointer(best.NICBaro),
			RC:             intPointer(best.RC),
			SIL:            intPointer(best.SIL),
			SILType:        stringPointer(best.SILType),
			Version:        intPointer(best.Version),
			Alert:          intPointer(best.Alert),
			SPI:            intPointer(best.SPI),
			NonICAO:        best.NonICAO != 0,
			Messages:       intPointer(best.Messages),
			RSSI:           roundedFloat(best.RSSI, 1),
			ObservedAt:     best.ObservedAt,
			PositionAt:     stringPointer(best.PositionAt),
			ReceiverCount:  len(receivers),
			BestReceiverID: best.ReceiverID,
			Receivers:      receivers,
		}
		result.Aircraft = append(result.Aircraft, aircraft)
		if aircraft.Lat != nil && aircraft.Lon != nil {
			result.Summary.WithPosition++
		}
		if aircraft.OnGround {
			result.Summary.OnGround++
		}
		if aircraft.NonICAO {
			result.Summary.NonICAO++
		}
		source := "unknown"
		if aircraft.SourceKind != nil && *aircraft.SourceKind != "" {
			source = *aircraft.SourceKind
		}
		result.Summary.Sources[source]++
	}
	sort.SliceStable(result.Aircraft, func(i, j int) bool {
		iPosition := result.Aircraft[i].Lat != nil && result.Aircraft[i].Lon != nil
		jPosition := result.Aircraft[j].Lat != nil && result.Aircraft[j].Lon != nil
		if iPosition != jPosition {
			return iPosition
		}
		iName := result.Aircraft[i].Hex
		if result.Aircraft[i].Flight != nil {
			iName = *result.Aircraft[i].Flight
		}
		jName := result.Aircraft[j].Hex
		if result.Aircraft[j].Flight != nil {
			jName = *result.Aircraft[j].Flight
		}
		return strings.Compare(iName, jName) < 0
	})
	result.Count = len(result.Aircraft)
	return result, nil
}

func PublicReceivers(ctx context.Context, db *sql.DB, now time.Time, window time.Duration) ([]PublicReceiver, error) {
	nowText := iso(now)
	cutoff := iso(now.Add(-window))
	rows, err := db.QueryContext(ctx, `
		SELECT
		  r.id, r.public_name, r.last_seen_at, r.total_ingests,
		  COUNT(c.hex) AS current_aircraft
		FROM receivers r
		LEFT JOIN receiver_aircraft_current c
		  ON c.receiver_id = r.id AND c.observed_at >= ?
		GROUP BY r.id
		ORDER BY r.public_name, r.id
	`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []PublicReceiver{}
	for rows.Next() {
		var receiver PublicReceiver
		var name, lastSeen sql.NullString
		if err := rows.Scan(
			&receiver.ID,
			&name,
			&lastSeen,
			&receiver.TotalIngests,
			&receiver.CurrentAircraft,
		); err != nil {
			return nil, err
		}
		receiver.Name = receiver.ID
		if name.Valid && name.String != "" {
			receiver.Name = name.String
		}
		receiver.LastSeenAt = stringPointer(lastSeen)
		if lastSeen.Valid {
			receiver.Online = millisecondsBetween(lastSeen.String, nowText) <= window.Milliseconds()
		}
		result = append(result, receiver)
	}
	return result, rows.Err()
}

func scanCurrentRow(rows *sql.Rows, value *currentRow) error {
	return rows.Scan(
		&value.ReceiverID, &value.Hex, &value.ObservedAt, &value.PositionAt, &value.Lat,
		&value.Lon, &value.Flight, &value.AltBaro, &value.AltGeom, &value.OnGround,
		&value.GS, &value.IAS, &value.TAS, &value.Mach, &value.Track, &value.TrueHeading,
		&value.MagHeading, &value.BaroRate, &value.GeomRate, &value.TrackRate, &value.Roll,
		&value.Squawk, &value.Category, &value.SourceType, &value.SourceKind, &value.Emergency,
		&value.NavQNH, &value.NavAltitudeMCP, &value.NavAltitudeFMS, &value.NavHeading,
		&value.WindDirection, &value.WindSpeed, &value.OAT, &value.TAT, &value.NACP,
		&value.NACV, &value.NIC, &value.NICBaro, &value.RC, &value.SIL, &value.SILType,
		&value.Version, &value.Alert, &value.SPI, &value.NonICAO, &value.Messages, &value.RSSI,
	)
}

func roundedFloat(value sql.NullFloat64, digits int) *float64 {
	if !value.Valid {
		return nil
	}
	scale := math.Pow10(digits)
	rounded := math.Round(value.Float64*scale) / scale
	return &rounded
}

func roundedInteger(value sql.NullFloat64) *int64 {
	if !value.Valid {
		return nil
	}
	rounded := int64(math.Floor(value.Float64 + 0.5))
	return &rounded
}

func stringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func intPointer(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func millisecondsBetween(first, second string) int64 {
	a, err := time.Parse(time.RFC3339Nano, first)
	if err != nil {
		return math.MaxInt64
	}
	b, err := time.Parse(time.RFC3339Nano, second)
	if err != nil {
		return math.MaxInt64
	}
	return b.Sub(a).Milliseconds()
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
